import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApiRouter, createApp } from '../../src/app.js';
import { RuntimeCoordinator } from '../../src/runtime.js';
import { openDatabase, type DatabaseConnection } from '../../src/db/client.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import type {
  DownloadQueue,
  QueuedDownload,
} from '../../src/services/download.js';

const FIRST_PLATFORM_VIDEO_ID = 'aB_12-cD345';
const SECOND_PLATFORM_VIDEO_ID = 'eF_67-gH890';
const PROXY_URL = 'http://alice:secret@proxy.example:8080';

const DEFAULT_ADVANCED_OPTIONS = {
  mediaType: 'video',
  format: null,
  quality: null,
  codec: null,
  writeSubtitles: false,
  writeThumbnail: false,
  splitChapters: false,
  timeRangeStart: null,
  timeRangeEnd: null,
  filenamePreset: null,
} as const;

function directInput(url: string, proxyId: number | null) {
  return {
    url,
    proxyId,
    targetSubdirectory: null,
    advancedOptions: DEFAULT_ADVANCED_OPTIONS,
  };
}

let sandbox: string;
let mountPath: string;
let downloadRoot: string;
let executablePath: string;
let database: DatabaseConnection;
let baseUrl: string;
let queued: QueuedDownload[];
let stopServer: (() => Promise<void>) | undefined;
let runtimeErrors: unknown[];

async function installFakeYtDlp(): Promise<void> {
  executablePath = join(sandbox, 'fake-yt-dlp.mjs');
  await writeFile(
    executablePath,
    `#!/usr/bin/env node
const url = process.argv.at(-1);
if (url === 'https://www.youtube.com/watch?v=${SECOND_PLATFORM_VIDEO_ID}') {
  process.stdout.write(JSON.stringify({
    extractor_key: 'Youtube',
    id: '${SECOND_PLATFORM_VIDEO_ID}',
    title: 'Direct video',
    upload_date: '20260716',
    webpage_url: url,
    live_status: 'not_live'
  }) + '\\n');
  process.exit(0);
}
process.stderr.write('probe failed');
process.exit(3);
`,
    'utf8',
  );
  await chmod(executablePath, 0o755);
}

function insertChannelVideo(): number {
  const now = '2026-07-17T08:00:00.000Z';
  const proxy = database
    .prepare(
      `INSERT INTO proxies (name, proxy_url, created_at, updated_at)
       VALUES ('office', ?, ?, ?)`,
    )
    .run(PROXY_URL, now, now);
  const channel = database
    .prepare(
      `INSERT INTO channels (
        platform, platform_channel_id, source_url, custom_name,
        custom_name_key, proxy_id, check_interval_minutes,
        initial_synced_at, created_at, updated_at
      ) VALUES ('youtube', 'UC-download-api', 'https://www.youtube.com/@downloads',
                'Saved channel', 'saved channel', ?, NULL, ?, ?, ?)`,
    )
    .run(Number(proxy.lastInsertRowid), now, now, now);
  const video = database
    .prepare(
      `INSERT INTO videos (
        channel_id, platform, platform_video_id, title, published_date,
        source_url, discovery_kind, discovered_at
      ) VALUES (?, 'youtube', ?, 'Channel video', '2026-07-15', ?,
                'historical', ?)`,
    )
    .run(
      Number(channel.lastInsertRowid),
      FIRST_PLATFORM_VIDEO_ID,
      `https://www.youtube.com/watch?v=${FIRST_PLATFORM_VIDEO_ID}`,
      now,
    );
  return Number(video.lastInsertRowid);
}

async function insertCompletedDownload(filename = 'fixture.webm'): Promise<number> {
  const outputPath = join(downloadRoot, filename);
  await writeFile(outputPath, Buffer.from([0, 1, 2, 3, 4]));
  const result = database
    .prepare(
      `INSERT INTO downloads (
        source_type, source_url, platform, platform_video_id, title,
        network_mode, status, output_path, created_at, started_at, finished_at
      ) VALUES (
        'direct', 'https://media.example/items/42', 'youtube',
        'aB_12-cD345', 'Fixture', 'direct', 'completed', ?, ?, ?, ?
      )`,
    )
    .run(
      outputPath,
      '2026-07-17T08:00:00.000Z',
      '2026-07-17T08:00:01.000Z',
      '2026-07-17T08:00:02.000Z',
    );
  return Number(result.lastInsertRowid);
}


async function request(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers.origin = baseUrl;
  return fetch(`${baseUrl}/api${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'vidharbor-download-api-'));
  mountPath = join(sandbox, 'downloads');
  downloadRoot = join(mountPath, 'library');
  await mkdir(downloadRoot, { recursive: true });
  await installFakeYtDlp();
  database = openDatabase(join(sandbox, 'vidharbor.sqlite'));
  migrateDatabase(database);
  database
    .prepare('UPDATE settings SET download_root = ?, updated_at = ? WHERE id = 1')
    .run(downloadRoot, '2026-07-17T08:00:00.000Z');
  queued = [];
  runtimeErrors = [];
  const queue: DownloadQueue = { enqueue: (download) => queued.push(download) };

  const server = createApp(
    createApiRouter(database, mountPath, new RuntimeCoordinator((error) => runtimeErrors.push(error)), executablePath, queue),
  ).listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  stopServer = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
});

afterEach(async () => {
  await stopServer?.();
  try {
    database.close();
  } catch {
    // A persistence-boundary assertion may close the connection.
  }
  await rm(sandbox, { recursive: true, force: true });
});

describe('download API', () => {
  it('streams download snapshots as server-sent events', async () => {
    insertChannelVideo();
    const response = await request('/downloads/events');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('missing SSE body');
    try {
      const chunk = await reader.read();
      const text = new TextDecoder().decode(chunk.value);
      expect(text).toContain('event: downloads');
      expect(text).toContain('"items"');
    } finally {
      await reader.cancel();
    }
  });

  it('closes an event stream and reports a periodic persistence failure', async () => {
    const response = await request('/downloads/events');
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('missing SSE body');
    await reader.read();

    database.close();
    await sleep(1_100);

    expect(runtimeErrors).toEqual([
      expect.objectContaining({ code: 'PERSISTENCE_ERROR' }),
    ]);
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it('creates a channel batch with a 202 fixed response and enqueues without exposing proxy URLs', async () => {
    const videoId = insertChannelVideo();
    const response = await request('/downloads/channel', 'POST', {
      videoIds: [videoId],
      proxyId: 'channel',
    });

    expect(response.status).toBe(202);
    const text = await response.text();
    expect(text).not.toContain(PROXY_URL);
    const body = JSON.parse(text) as { downloads: Array<Record<string, unknown>> };
    expect(body.downloads).toEqual([
      {
        id: expect.any(Number),
        sourceType: 'channel',
        title: 'Channel video',
        status: 'pending',
        outputPath: null,
        failureReason: null,
        progressPercent: null,
        speedText: null,
        etaSeconds: null,
        exitCode: null,
        createdAt: expect.any(String),
        startedAt: null,
        finishedAt: null,
        networkMode: 'proxy',
        proxyName: 'office',
      },
    ]);
    expect(Object.keys(body.downloads[0] ?? {})).toEqual([
      'id',
      'sourceType',
      'title',
      'status',
      'outputPath',
      'failureReason',
      'progressPercent',
      'speedText',
      'etaSeconds',
      'exitCode',
      'createdAt',
      'startedAt',
      'finishedAt',
      'networkMode',
      'proxyName',
    ]);
    expect(queued).toHaveLength(1);
  });

  it('creates a direct download with 202 after metadata probing', async () => {
    const response = await request('/downloads/direct', 'POST', directInput(`https://youtu.be/${SECOND_PLATFORM_VIDEO_ID}`, null));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      download: {
        id: expect.any(Number),
        sourceType: 'direct',
        title: 'Direct video',
        status: 'pending',
        outputPath: null,
        failureReason: null,
        progressPercent: null,
        speedText: null,
        etaSeconds: null,
        exitCode: null,
        createdAt: expect.any(String),
        startedAt: null,
        finishedAt: null,
        networkMode: 'direct',
        proxyName: null,
      },
    });
    expect(queued).toHaveLength(1);
  });

  it('rejects non-contract bodies and keeps a partially invalid channel batch atomic', async () => {
    const videoId = insertChannelVideo();
    const invalidRequests: Array<[string, unknown]> = [
      ['/downloads/channel', { videoIds: [] }],
      ['/downloads/channel', { videoIds: [videoId, videoId], proxyId: 'channel' }],
      ['/downloads/channel', { videoIds: [videoId], proxyId: 'channel', quality: 'best' }],
      ['/downloads/channel', { videos: [videoId] }],
      ['/downloads/channel', { videoIds: [videoId] }],
      ['/downloads/channel', { videoIds: [videoId], proxyId: 'direct' }],
      [
        '/downloads/direct',
        { url: `https://youtu.be/${SECOND_PLATFORM_VIDEO_ID}`, proxyId: null, quality: 'best' },
      ],
      ['/downloads/direct', { url: `https://youtu.be/${SECOND_PLATFORM_VIDEO_ID}` }],
    ];

    for (const [path, body] of invalidRequests) {
      const response = await request(path, 'POST', body);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'VALIDATION_ERROR' },
      });
    }

    const atomicResponse = await request('/downloads/channel', 'POST', {
      videoIds: [videoId, 999],
      proxyId: 'channel',
    });
    expect(atomicResponse.status).toBe(404);
    await expect(atomicResponse.json()).resolves.toMatchObject({
      error: { code: 'VIDEO_NOT_FOUND' },
    });
    expect(database.prepare('SELECT COUNT(*) FROM downloads').pluck().get()).toBe(0);
    expect(queued).toEqual([]);
  });

  it('rejects an unknown direct proxy before probing or creating a record', async () => {
    const response = await request('/downloads/direct', 'POST', directInput(`https://youtu.be/${SECOND_PLATFORM_VIDEO_ID}`, 999));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PROXY_NOT_FOUND' },
    });
    expect(database.prepare('SELECT COUNT(*) FROM downloads').pluck().get()).toBe(0);
  });

  it('lists the fixed persisted shape by createdAt and id descending', async () => {
    const videoId = insertChannelVideo();
    await request('/downloads/channel', 'POST', { videoIds: [videoId], proxyId: 'channel' });
    await request('/downloads/direct', 'POST', directInput(`https://youtu.be/${SECOND_PLATFORM_VIDEO_ID}`, null));
    database
      .prepare('UPDATE downloads SET created_at = ?')
      .run('2026-07-17T09:00:00.000Z');

    const response = await request('/downloads');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items.map((item) => item.sourceType)).toEqual(['direct', 'channel']);
    expect(Object.keys(body.items[0] ?? {})).toEqual([
      'id',
      'sourceType',
      'title',
      'sourceUrl',
      'status',
      'outputPath',
      'failureReason',
      'progressPercent',
      'speedText',
      'etaSeconds',
      'exitCode',
      'createdAt',
      'startedAt',
      'finishedAt',
      'networkMode',
      'proxyName',
    ]);
    expect(body.items[0]?.sourceUrl).toBe(
      `https://youtu.be/${SECOND_PLATFORM_VIDEO_ID}`,
    );
    expect(JSON.stringify(body)).not.toContain(PROXY_URL);
  });

  it('maps download history persistence failures', async () => {
    database.close();
    const response = await request('/downloads');
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PERSISTENCE_ERROR' },
    });
  });

  it('serves completed media inline, by range, and as an attachment', async () => {
    const id = await insertCompletedDownload();

    const media = await request(`/downloads/${id}/media`);
    expect(media.status).toBe(200);
    expect(media.headers.get('content-type')).toContain('video/webm');
    expect(media.headers.get('content-disposition')).toBeNull();
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(
      new Uint8Array([0, 1, 2, 3, 4]),
    );

    const ranged = await fetch(`${baseUrl}/api/downloads/${id}/media`, {
      headers: { range: 'bytes=1-3' },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe('bytes 1-3/5');
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );

    const invalidRange = await fetch(`${baseUrl}/api/downloads/${id}/media`, {
      headers: { range: 'bytes=99-100' },
    });
    expect(invalidRange.status).toBe(416);
    expect(invalidRange.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    );
    await expect(invalidRange.json()).resolves.toEqual({
      error: {
        code: 'DOWNLOAD_RANGE_NOT_SATISFIABLE',
        message: 'download range not satisfiable',
      },
    });

    const attachment = await request(`/downloads/${id}/file`);
    expect(attachment.status).toBe(200);
    expect(attachment.headers.get('content-type')).toContain('video/webm');
    expect(attachment.headers.get('content-disposition')).toContain(
      'attachment; filename="fixture.webm"',
    );
    expect(new Uint8Array(await attachment.arrayBuffer())).toEqual(
      new Uint8Array([0, 1, 2, 3, 4]),
    );
  });

  it('returns JSON errors for invalid, missing, incomplete, and missing-file requests', async () => {
    const pending = database
      .prepare(
        `INSERT INTO downloads (
          source_type, source_url, platform, platform_video_id, title,
          network_mode, status, created_at
        ) VALUES (
          'direct', 'https://media.example/pending', 'youtube',
          'eF_67-gH890', 'Pending', 'direct', 'pending', ?
        )`,
      )
      .run('2026-07-17T08:00:00.000Z');
    const missingFile = await insertCompletedDownload('missing.webm');
    await rm(join(downloadRoot, 'missing.webm'));

    const cases = [
      ['/downloads/no/media', 400, 'VALIDATION_ERROR'],
      ['/downloads/999/media', 404, 'DOWNLOAD_NOT_FOUND'],
      [`/downloads/${pending.lastInsertRowid}/media`, 404, 'DOWNLOAD_FILE_UNAVAILABLE'],
      [`/downloads/${missingFile}/file`, 404, 'DOWNLOAD_FILE_UNAVAILABLE'],
    ] as const;
    for (const [path, status, code] of cases) {
      const response = await request(path);
      expect(response.status).toBe(status);
      expect(response.headers.get('content-type')).toBe(
        'application/json; charset=utf-8',
      );
      await expect(response.json()).resolves.toMatchObject({ error: { code } });
    }
  });

});
