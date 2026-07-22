import { type NextFunction, type Request, type Response, Router } from 'express';

import type { DatabaseConnection } from '../db/client.js';
import { BusinessError } from '../errors.js';
import { closeReadableOnPrematureResponseClose } from '../http/file-stream.js';
import {
  PAGE_SIZE,
  pageOffset,
  pagination,
  parsePage,
  parseQuery,
} from '../http/pagination.js';
import type { RuntimeCoordinator } from '../runtime.js';
import type { YtDlpTaskManager } from '../yt-dlp-task-manager.js';
import {
  cancelDownload,
  createChannelDownloads,
  createDirectDownload,
  deleteDownload,
  getDownloadFile,
  getDownloadThumbnail,
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
  readonly platform: string;
  readonly title: string;
  readonly source_url: string;
  readonly status:
    | 'pending'
    | 'downloading'
    | 'running'
    | 'completed'
    | 'failed'
    | 'canceled'
    | 'interrupted'
    | 'deleting';
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
  readonly duration_seconds: number | null;
  readonly thumbnail_path: string | null;
  readonly output_size_bytes: number | null;
}

type DownloadTab = 'all' | 'active' | 'completed' | 'failed';

interface DownloadStatusCounts {
  pending: number;
  downloading: number;
  running: number;
  completed: number;
  failed: number;
  canceled: number;
  interrupted: number;
  deleting: number;
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

function parseDownloadTab(value: unknown): DownloadTab {
  if (value === undefined) return 'all';
  if (value !== 'active' && value !== 'completed' && value !== 'failed') {
    throw new BusinessError('VALIDATION_ERROR', 'invalid download tab');
  }
  return value;
}

function toDownloadSnapshot(row: DownloadRow): Record<string, unknown> {
  return {
    id: row.id,
    sourceType: row.source_type,
    platform: row.platform,
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
    durationSeconds: row.duration_seconds,
    thumbnailUrl: row.thumbnail_path === null ? null : `/api/downloads/${row.id}/thumbnail`,
    outputSizeBytes: row.output_size_bytes,
  };
}

function listDownloads(
  database: DatabaseConnection,
  page: number,
  tab: DownloadTab,
  query: string,
): Record<string, unknown> {
  try {
    const conditions: string[] = [];
    const parameters: unknown[] = [];
    if (tab === 'active') {
      conditions.push("status IN ('pending', 'downloading', 'running', 'deleting')");
    }
    if (tab === 'completed') conditions.push("status = 'completed'");
    if (tab === 'failed') conditions.push("status IN ('failed', 'canceled', 'interrupted')");
    if (query !== '') {
      conditions.push('instr(lower(title), lower(?)) > 0');
      parameters.push(query);
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const totalItems = database
      .prepare(`SELECT COUNT(*) FROM downloads ${where}`)
      .pluck()
      .get(...parameters) as number;
    const rows = database
      .prepare(
        `SELECT id, source_type, platform, title, source_url, status, output_path, failure_reason,
                progress_percent, speed_text, eta_seconds, exit_code,
                created_at, started_at, finished_at, network_mode, proxy_name,
                duration_seconds, thumbnail_path, output_size_bytes
         FROM downloads
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...parameters, PAGE_SIZE, pageOffset(page)) as DownloadRow[];
    const counts: DownloadStatusCounts = {
      pending: 0,
      downloading: 0,
      running: 0,
      completed: 0,
      failed: 0,
      canceled: 0,
      interrupted: 0,
      deleting: 0,
    };
    const countRows = database
      .prepare('SELECT status, COUNT(*) AS count FROM downloads GROUP BY status')
      .all() as Array<{ status: keyof DownloadStatusCounts; count: number }>;
    for (const row of countRows) counts[row.status] = row.count;
    return {
      items: rows.map(toDownloadSnapshot),
      pagination: pagination(page, totalItems),
      statusCounts: counts,
    };
  } catch {
    throw new BusinessError('PERSISTENCE_ERROR', 'download persistence failed');
  }
}

function getDownloadSnapshot(database: DatabaseConnection, downloadId: number): unknown {
  try {
    const row = database
      .prepare(
        `SELECT id, source_type, platform, title, source_url, status, output_path, failure_reason,
                progress_percent, speed_text, eta_seconds, exit_code,
                created_at, started_at, finished_at, network_mode, proxy_name,
                duration_seconds, thumbnail_path, output_size_bytes
         FROM downloads WHERE id = ?`,
      )
      .get(downloadId) as DownloadRow | undefined;
    if (row === undefined) throw new BusinessError('DOWNLOAD_NOT_FOUND', 'download not found');
    return toDownloadSnapshot(row);
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    throw new BusinessError('PERSISTENCE_ERROR', 'download persistence failed');
  }
}

export function createDownloadsRouter(
  database: DatabaseConnection,
  downloadsMountPath: string,
  taskManager: YtDlpTaskManager,
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
      taskManager,
      downloadsMountPath,
      request.body,
      queue,
    );
    response.status(202).json({ download });
  });

  router.get('/', (request, response) => {
    response.json(listDownloads(
      database,
      parsePage(request.query.page),
      parseDownloadTab(request.query.tab),
      parseQuery(request.query.q),
    ));
  });

  router.get('/events', (request, response) => {
    const page = parsePage(request.query.page);
    const tab = parseDownloadTab(request.query.tab);
    const query = parseQuery(request.query.q);
    response.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    let previousSnapshot: string | undefined;
    const sendChangedSnapshot = () => {
      const snapshot = JSON.stringify(listDownloads(database, page, tab, query));
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

  router.get('/:id', (request, response) => {
    response.json({ download: getDownloadSnapshot(database, parseDownloadId(request.params.id)) });
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

  router.get('/:id/thumbnail', async (request, response, next) => {
    try {
      const file = await getDownloadThumbnail(
        database,
        downloadsMountPath,
        parseDownloadId(request.params.id),
      );
      await sendDownloadFile(request, response, next, file, false);
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
