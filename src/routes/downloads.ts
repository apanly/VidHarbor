import { type NextFunction, type Request, type Response, Router } from 'express';

import type { DatabaseConnection } from '../db/client.js';
import { BusinessError } from '../errors.js';
import { closeReadableOnPrematureResponseClose } from '../http/file-stream.js';
import type { RuntimeCoordinator } from '../runtime.js';
import {
  cancelDownload,
  createChannelDownloads,
  createDirectDownload,
  deleteDownload,
  getDownloadFile,
  retryDownload,
  type ChannelDownloadProxySelection,
  type DownloadQueue,
  type DownloadFile,
} from '../services/download.js';

const DOWNLOAD_EVENT_INTERVAL_MILLISECONDS = 10_000;

interface ByteRange {
  readonly start: number;
  readonly end: number;
}

function parseByteRange(value: string | undefined, size: number): ByteRange {
  if (value === undefined) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (match === null || (match[1] === '' && match[2] === '')) {
    throw new BusinessError(
      'DOWNLOAD_RANGE_NOT_SATISFIABLE',
      'download range not satisfiable',
    );
  }

  let start: number;
  let end: number;
  if (match[1] === '') {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength < 1 || size < 1) {
      throw new BusinessError(
        'DOWNLOAD_RANGE_NOT_SATISFIABLE',
        'download range not satisfiable',
      );
    }
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start >= size ||
      end < start
    ) {
      throw new BusinessError(
        'DOWNLOAD_RANGE_NOT_SATISFIABLE',
        'download range not satisfiable',
      );
    }
  }
  return { start, end };
}

async function sendDownloadFile(
  request: Request,
  response: Response,
  next: NextFunction,
  file: DownloadFile,
  attachment: boolean,
): Promise<void> {
  let range: ByteRange;
  try {
    range = parseByteRange(request.get('range'), file.size);
  } catch (error) {
    response.set('Content-Range', `bytes */${file.size}`);
    await file.handle.close();
    throw error;
  }

  response.removeHeader('Content-Type');
  response.type(file.filename);
  response.set({
    'Accept-Ranges': 'bytes',
    'Content-Length': String(file.size === 0 ? 0 : range.end - range.start + 1),
  });
  if (attachment) response.attachment(file.filename);
  if (request.get('range') !== undefined) {
    response.status(206).set(
      'Content-Range',
      `bytes ${range.start}-${range.end}/${file.size}`,
    );
  }
  if (request.method === 'HEAD' || file.size === 0) {
    await file.handle.close();
    response.end();
    return;
  }

  const stream = file.handle.createReadStream({
    start: range.start,
    end: range.end,
  });
  stream.once('error', (error) => {
    if (response.headersSent) response.destroy(error);
    else next(new BusinessError('DOWNLOAD_FILE_UNAVAILABLE', 'download file unavailable'));
  });
  closeReadableOnPrematureResponseClose(stream, response);
  stream.pipe(response);
}

interface DownloadRow {
  readonly id: number;
  readonly source_type: 'channel' | 'direct';
  readonly title: string;
  readonly source_url: string;
  readonly status:
    | 'pending'
    | 'downloading'
    | 'running'
    | 'completed'
    | 'failed'
    | 'canceled'
    | 'interrupted';
  readonly output_path: string | null;
  readonly failure_reason: string | null;
  readonly progress_percent: number | null;
  readonly speed_text: string | null;
  readonly eta_seconds: number | null;
  readonly exit_code: number | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly network_mode: 'direct' | 'proxy';
  readonly proxy_name: string | null;
}

function parseDownloadId(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid download ID');
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id)) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid download ID');
  }
  return id;
}

function assertEmptyBody(input: unknown): void {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).length !== 0
  ) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid download action input');
  }
}

interface ChannelDownloadInput {
  readonly videoIds: readonly number[];
  readonly proxyId: ChannelDownloadProxySelection;
}

function parseChannelInput(input: unknown): ChannelDownloadInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid channel download input');
  }

  const keys = Object.keys(input);
  if (
    keys.length !== 2 ||
    !keys.includes('videoIds') ||
    !keys.includes('proxyId')
  ) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid channel download input');
  }

  const value = input as Record<string, unknown>;
  const videoIds = value.videoIds;
  if (!Array.isArray(videoIds)) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid channel download input');
  }
  if (
    value.proxyId !== 'channel' &&
    value.proxyId !== null &&
    (!Number.isSafeInteger(value.proxyId) || (value.proxyId as number) < 1)
  ) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid channel download input');
  }
  return {
    videoIds: videoIds as unknown as readonly number[],
    proxyId: value.proxyId as ChannelDownloadProxySelection,
  };
}

function listDownloads(database: DatabaseConnection): unknown[] {
  try {
    const rows = database
      .prepare(
        `SELECT id, source_type, title, source_url, status, output_path, failure_reason,
                progress_percent, speed_text, eta_seconds, exit_code,
                created_at, started_at, finished_at, network_mode, proxy_name
         FROM downloads
         ORDER BY created_at DESC, id DESC`,
      )
      .all() as DownloadRow[];

    return rows.map((row) => ({
      id: row.id,
      sourceType: row.source_type,
      title: row.title,
      sourceUrl: row.source_url,
      status: row.status,
      outputPath: row.output_path,
      failureReason: row.failure_reason,
      progressPercent: row.progress_percent,
      speedText: row.speed_text,
      etaSeconds: row.eta_seconds,
      exitCode: row.exit_code,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      networkMode: row.network_mode,
      proxyName: row.proxy_name,
    }));
  } catch {
    throw new BusinessError('PERSISTENCE_ERROR', 'download persistence failed');
  }
}

export function createDownloadsRouter(
  database: DatabaseConnection,
  downloadsMountPath: string,
  ytDlpExecutablePath: string,
  queue: DownloadQueue,
  runtime: RuntimeCoordinator,
): Router {
  const router = Router();

  router.post('/channel', async (request, response) => {
    const input = parseChannelInput(request.body);
    const downloads = await createChannelDownloads(
      database,
      downloadsMountPath,
      input.videoIds,
      queue,
      new Date(),
      input.proxyId,
    );
    response.status(202).json({ downloads });
  });

  router.post('/direct', async (request, response) => {
    const download = await createDirectDownload(
      database,
      ytDlpExecutablePath,
      downloadsMountPath,
      request.body,
      queue,
    );
    response.status(202).json({ download });
  });

  router.get('/', (_request, response) => {
    response.json({ items: listDownloads(database) });
  });

  router.get('/events', (request, response) => {
    response.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    let previousSnapshot: string | undefined;
    const sendChangedSnapshot = () => {
      const snapshot = JSON.stringify({ items: listDownloads(database) });
      if (snapshot === previousSnapshot) return;
      previousSnapshot = snapshot;
      response.write(`event: downloads\ndata: ${snapshot}\n\n`);
    };
    sendChangedSnapshot();
    const unregister = runtime.registerDownloadEventStream(response);
    const close = () => {
      clearInterval(timer);
      unregister();
      if (!response.writableEnded) response.end();
    };
    const timer = setInterval(() => {
      try {
        sendChangedSnapshot();
      } catch (error) {
        close();
        runtime.reportError(error);
      }
    }, DOWNLOAD_EVENT_INTERVAL_MILLISECONDS);
    request.on('close', close);
  });

  router.get('/:id/media', async (request, response, next) => {
    try {
      const file = await getDownloadFile(
        database,
        downloadsMountPath,
        parseDownloadId(request.params.id),
      );
      await sendDownloadFile(request, response, next, file, false);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id/file', async (request, response, next) => {
    try {
      const file = await getDownloadFile(
        database,
        downloadsMountPath,
        parseDownloadId(request.params.id),
      );
      await sendDownloadFile(request, response, next, file, true);
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/cancel', async (request, response) => {
    assertEmptyBody(request.body);
    await cancelDownload(database, parseDownloadId(request.params.id), queue);
    response.status(204).end();
  });

  router.post('/:id/retry', async (request, response) => {
    assertEmptyBody(request.body);
    await retryDownload(
      database,
      downloadsMountPath,
      parseDownloadId(request.params.id),
      queue,
    );
    response.status(202).end();
  });

  router.delete('/:id', async (request, response) => {
    await deleteDownload(
      database,
      downloadsMountPath,
      parseDownloadId(request.params.id),
    );
    response.status(204).end();
  });

  return router;
}
