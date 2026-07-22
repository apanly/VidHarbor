import { access, chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApiRouter, createApp } from '../../src/app.js';
import { RuntimeCoordinator } from '../../src/runtime.js';
import { openDatabase, type DatabaseConnection } from '../../src/db/client.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { CookieAuthorizationService } from '../../src/services/cookie-authorization.js';
import type {
  DownloadQueue,
  QueuedDownload,
} from '../../src/services/download.js';
import { YtDlpTaskManager } from '../../src/yt-dlp-task-manager.js';

const FIRST_PLATFORM_VIDEO_ID = 'aB_12-cD345';
const SECOND_PLATFORM_VIDEO_ID = 'eF_67-gH890';
const GENERIC_VIDEO_ID = 'generic-123456789';
const GENERIC_VIDEO_URL = `https://media.example/videos/${GENERIC_VIDEO_ID}`;
const VIMEO_COMPATIBILITY_VIDEO_ID = '123456789';
const VIMEO_COMPATIBILITY_VIDEO_URL = `https://vimeo.com/${VIMEO_COMPATIBILITY_VIDEO_ID}`;
const BILIBILI_VIDEO_ID = 'BV13x41117TL';
const BILIBILI_VIDEO_URL = `https://www.bilibili.com/video/${BILIBILI_VIDEO_ID}`;
const X_VIDEO_ID = '2001841416071450628';
const X_VIDEO_URL = 'https://x.com/TopHeroes_/status/2001950365332455490';
const FACEBOOK_VIDEO_ID = '3676516585958356';
const FACEBOOK_VIDEO_URL = `https://www.facebook.com/radiokicksfm/videos/${FACEBOOK_VIDEO_ID}`;
const FACEBOOK_REEL_ID = '1195289147628387';
const FACEBOOK_REEL_URL = `https://www.facebook.com/reel/${FACEBOOK_REEL_ID}`;
const DOUYIN_VIDEO_ID = '6961737553342991651';
const DOUYIN_VIDEO_URL = `https://www.douyin.com/video/${DOUYIN_VIDEO_ID}`;
const PROXY_URL = 'http://alice:secret@proxy.example:8080';

const DEFAULT_ADVANCED_OPTIONS = {
  mediaType: 'video',
  format: null,
  quality: null,
  codec: null,
  writeSubtitles: false,
  splitChapters: false,
  timeRangeStart: null,
  timeRangeEnd: null,
} as const;

function directInput(url: string, proxyId: number | null) {
  return {
    url,
    proxyId,
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
let taskManager: YtDlpTaskManager;

async function installFakeYtDlp(): Promise<void> {
  executablePath = join(sandbox, 'fake-yt-dlp.mjs');
  await writeFile(
    executablePath,
    `#!/usr/bin/env node
const url = process.argv.at(-1);
if (url === 'https://www.youtube.com/watch?v=${SECOND_PLATFORM_VIDEO_ID}' || url === 'https://youtu.be/${SECOND_PLATFORM_VIDEO_ID}') {
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
if (url === '${GENERIC_VIDEO_URL}') {
  process.stdout.write(JSON.stringify({
    extractor_key: 'Generic',
    id: '${GENERIC_VIDEO_ID}',
    title: 'Generic video',
    duration: 125.2
  }) + '\\n');
  process.exit(0);
}
if (url === '${VIMEO_COMPATIBILITY_VIDEO_URL}') {
  if (!process.argv.includes('--no-playlist')) {
    process.stderr.write('single-resource probe required');
    process.exit(3);
  }
  process.stdout.write(JSON.stringify({
    extractor_key: 'Vimeo',
    id: '${VIMEO_COMPATIBILITY_VIDEO_ID}',
    title: 'Vimeo compatibility fixture'
  }) + '\\n');
  process.exit(0);
}
if (url === '${BILIBILI_VIDEO_URL}') {
  process.stdout.write(JSON.stringify({
    extractor_key: 'BiliBili',
    id: '${BILIBILI_VIDEO_ID}',
    title: 'Bilibili video'
  }) + '\\n');
  process.exit(0);
}
if (url === '${X_VIDEO_URL}') {
  process.stdout.write(JSON.stringify({
    extractor_key: 'Twitter',
    id: '${X_VIDEO_ID}',
    title: 'X video'
  }) + '\\n');
  process.exit(0);
}
if (url === '${FACEBOOK_VIDEO_URL}' || url === '${FACEBOOK_REEL_URL}') {
  const isReel = url === '${FACEBOOK_REEL_URL}';
  process.stdout.write(JSON.stringify({
    extractor_key: 'Facebook',
    id: isReel ? '${FACEBOOK_REEL_ID}' : '${FACEBOOK_VIDEO_ID}',
    title: isReel ? 'Facebook Reel' : 'Facebook video'
  }) + '\\n');
  process.exit(0);
}
if (url === '${DOUYIN_VIDEO_URL}') {
  process.stdout.write(JSON.stringify({
    extractor_key: 'Douyin',
    id: '${DOUYIN_VIDEO_ID}',
    title: 'Douyin video'
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
  taskManager = new YtDlpTaskManager(executablePath, 1, (message) => message);
  const queue: DownloadQueue = {
    enqueue: (download) => queued.push(download),
    cancel: async () => undefined,
  };
  const cookieAuthorizationService = new CookieAuthorizationService(
    join(sandbox, 'cookies'),
  );
  await cookieAuthorizationService.initialize();

  const server = createApp(
    createApiRouter(
      database,
      mountPath,
      new RuntimeCoordinator((error) => runtimeErrors.push(error)),
      taskManager,
      queue,
      cookieAuthorizationService,
    ),
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
  await taskManager.stop();
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

  it('checks every ten seconds and emits only when the download snapshot changes', async () => {
    vi.useFakeTimers();
    try {
      const response = await request('/downloads/events');
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error('missing SSE body');
      await reader.read();

      let settled = false;
      const changedSnapshot = reader.read().then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(settled).toBe(false);

      database
        .prepare(
          `INSERT INTO downloads (
            source_type, source_url, platform, platform_video_id, title,
            network_mode, status, created_at
          ) VALUES ('direct', 'https://media.example/videos/changed', 'generic',
                    'changed', 'Changed', 'direct', 'pending', ?)`,
        )
        .run('2026-07-17T09:00:00.000Z');
      await vi.advanceTimersByTimeAsync(10_000);

      const chunk = await changedSnapshot;
      expect(new TextDecoder().decode(chunk.value)).toContain('"title":"Changed"');
      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes an event stream and reports a periodic persistence failure', async () => {
    vi.useFakeTimers();
    try {
      const response = await request('/downloads/events');
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error('missing SSE body');
      await reader.read();
      database.close();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(runtimeErrors).toEqual([
        expect.objectContaining({ code: 'PERSISTENCE_ERROR' }),
      ]);
      await expect(reader.read()).resolves.toMatchObject({ done: true });
    } finally {
      vi.useRealTimers();
    }
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
        durationSeconds: null,
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
      'durationSeconds',
    ]);
    expect(queued).toHaveLength(1);
  });

  it('creates a generic direct download with 202 after metadata probing', async () => {
    const response = await request('/downloads/direct', 'POST', directInput(GENERIC_VIDEO_URL, null));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      download: {
        id: expect.any(Number),
        sourceType: 'direct',
        title: 'Generic video',
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
        durationSeconds: 126,
      },
    });
    expect(queued).toHaveLength(1);
    expect(taskManager.getSnapshot()).toMatchObject([
      { type: 'metadata_probe', status: 'succeeded' },
    ]);
    expect(database.prepare('SELECT platform, duration_seconds FROM downloads').get())
      .toEqual({ platform: 'generic', duration_seconds: 126 });
  });

  it('keeps Vimeo URLs on the generic single-resource metadata path without a domain blacklist', async () => {
    const response = await request(
      '/downloads/direct',
      'POST',
      directInput(VIMEO_COMPATIBILITY_VIDEO_URL, null),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      download: {
        sourceType: 'direct',
        title: 'Vimeo compatibility fixture',
        status: 'pending',
      },
    });
    expect(database
      .prepare('SELECT source_url, platform, platform_video_id FROM downloads')
      .get()).toEqual({
      source_url: VIMEO_COMPATIBILITY_VIDEO_URL,
      platform: 'vimeo',
      platform_video_id: VIMEO_COMPATIBILITY_VIDEO_ID,
    });
    expect(queued).toEqual([
      expect.objectContaining({
        sourceUrl: VIMEO_COMPATIBILITY_VIDEO_URL,
        platformVideoId: VIMEO_COMPATIBILITY_VIDEO_ID,
      }),
    ]);
  });

  it.each([
    [BILIBILI_VIDEO_URL, 'Bilibili video', 'bilibili', BILIBILI_VIDEO_ID],
    [X_VIDEO_URL, 'X video', 'twitter', X_VIDEO_ID],
    [FACEBOOK_VIDEO_URL, 'Facebook video', 'facebook', FACEBOOK_VIDEO_ID],
    [FACEBOOK_REEL_URL, 'Facebook Reel', 'facebook', FACEBOOK_REEL_ID],
    [DOUYIN_VIDEO_URL, 'Douyin video', 'douyin', DOUYIN_VIDEO_ID],
  ])('creates a direct download for %s', async (url, title, platform, platformVideoId) => {
    const response = await request('/downloads/direct', 'POST', directInput(url, null));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      download: { sourceType: 'direct', title, status: 'pending' },
    });
    expect(database
      .prepare('SELECT source_url, platform, platform_video_id FROM downloads')
      .get()).toEqual({
      source_url: url,
      platform,
      platform_video_id: platformVideoId,
    });
    expect(queued).toEqual([
      expect.objectContaining({ sourceUrl: url, platformVideoId }),
    ]);
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
      [
        '/downloads/direct',
        {
          ...directInput(`https://youtu.be/${SECOND_PLATFORM_VIDEO_ID}`, null),
          advancedOptions: {
            ...DEFAULT_ADVANCED_OPTIONS,
            filenamePreset: null,
          },
        },
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
      'platform',
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
      'durationSeconds',
      'thumbnailUrl',
      'outputSizeBytes',
    ]);
    expect(body.items[0]?.sourceUrl).toBe(
      `https://youtu.be/${SECOND_PLATFORM_VIDEO_ID}`,
    );
    expect(JSON.stringify(body)).not.toContain(PROXY_URL);
  });

  it('paginates downloads after server-side tab and title filtering', async () => {
    const insert = database.prepare(
      `INSERT INTO downloads (
        source_type, source_url, platform, platform_video_id, title,
        network_mode, status, created_at
      ) VALUES ('direct', ?, 'generic', ?, ?, 'direct', 'pending', ?)`,
    );
    for (let index = 1; index <= 21; index += 1) {
      insert.run(
        `https://media.example/videos/${String(index)}`,
        `page_${String(index)}`,
        index === 7 ? 'Unique Search Title' : `Download ${String(index)}`,
        `2026-07-17T09:00:${String(index).padStart(2, '0')}.000Z`,
      );
    }
    database
      .prepare(
        `INSERT INTO downloads (
          source_type, source_url, platform, platform_video_id, title,
          network_mode, status, output_path, output_size_bytes, created_at
        ) VALUES ('direct', 'https://media.example/videos/completed', 'generic',
                  'completed_page', 'Completed', 'direct', 'completed',
                  '/downloads/completed_page.webm', 2048, ?)`,
      )
      .run('2026-07-17T10:00:00.000Z');
    const insertTerminal = database.prepare(
      `INSERT INTO downloads (
        source_type, source_url, platform, platform_video_id, title,
        network_mode, status, failure_reason, created_at, finished_at
      ) VALUES ('direct', ?, 'generic', ?, ?, 'direct', ?, 'stopped', ?, ?)`,
    );
    for (const [status, id] of [['failed', 'failed_page'], ['canceled', 'canceled_page'], ['interrupted', 'interrupted_page']] as const) {
      insertTerminal.run(
        `https://media.example/videos/${id}`,
        id,
        id,
        status,
        '2026-07-17T10:01:00.000Z',
        '2026-07-17T10:02:00.000Z',
      );
    }

    const secondPage = await request('/downloads?page=2&tab=active');
    expect(secondPage.status).toBe(200);
    await expect(secondPage.json()).resolves.toMatchObject({
      items: [expect.any(Object)],
      pagination: { page: 2, pageSize: 20, totalItems: 21, totalPages: 2 },
      statusCounts: { pending: 21, completed: 1, failed: 1, canceled: 1, interrupted: 1 },
    });

    const completed = await request('/downloads?page=1&tab=completed');
    await expect(completed.json()).resolves.toMatchObject({
      items: [{ title: 'Completed', outputSizeBytes: 2048 }],
      pagination: { totalItems: 1, totalPages: 1 },
    });
    const failed = await request('/downloads?page=1&tab=failed');
    await expect(failed.json()).resolves.toMatchObject({
      items: [
        { status: 'interrupted' },
        { status: 'canceled' },
        { status: 'failed' },
      ],
      pagination: { totalItems: 3, totalPages: 1 },
    });
    const searched = await request('/downloads?page=1&tab=active&q=unique');
    await expect(searched.json()).resolves.toMatchObject({
      items: [{ title: 'Unique Search Title' }],
      pagination: { totalItems: 1 },
    });
    const outOfRange = await request('/downloads?page=999&tab=active');
    await expect(outOfRange.json()).resolves.toMatchObject({
      items: [],
      pagination: { page: 999, totalItems: 21, totalPages: 2 },
    });
    const missingDownload = await request('/downloads/999999');
    expect(missingDownload.status).toBe(404);
    await expect(missingDownload.json()).resolves.toMatchObject({
      error: { code: 'DOWNLOAD_NOT_FOUND' },
    });
    for (const path of ['/downloads?page=0', '/downloads?page=1&tab=all', '/downloads?page=1&q=%20bad']) {
      const response = await request(path);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
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

  it('serves a stored thumbnail from a download ID directory', async () => {
    const createdAt = '2026-07-17T08:00:00.000Z';
    const inserted = database.prepare(
      `INSERT INTO downloads (
        source_type, source_url, platform, platform_video_id, title,
        network_mode, archive_layout, status, created_at
      ) VALUES ('direct', 'https://media.example/thumbnail', 'generic',
                'thumbnail-video', 'Thumbnail', 'direct',
                'download_directory', 'pending', ?)`,
    ).run(createdAt);
    const id = Number(inserted.lastInsertRowid);
    const directory = join(downloadRoot, String(id));
    await mkdir(directory);
    const mediaPath = join(directory, 'thumbnail-video.mp4');
    const thumbnailPath = join(directory, 'thumbnail-video.jpg');
    await writeFile(mediaPath, 'media');
    await writeFile(thumbnailPath, 'thumbnail');
    database.prepare(
      `UPDATE downloads
       SET status = 'completed', output_path = ?, thumbnail_path = ?, finished_at = ?
       WHERE id = ?`,
    ).run(mediaPath, thumbnailPath, createdAt, id);

    const response = await request(`/downloads/${id}/thumbnail`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/jpeg');
    await expect(response.text()).resolves.toBe('thumbnail');

    const deleted = await request(`/downloads/${id}`, 'DELETE');
    expect(deleted.status).toBe(204);
    await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('deletes a completed download file and its record together', async () => {
    const filename = 'delete-me.webm';
    const outputPath = join(downloadRoot, filename);
    const id = await insertCompletedDownload(filename);

    const response = await request(`/downloads/${id}`, 'DELETE');

    expect(response.status).toBe(204);
    await expect(access(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(database.prepare('SELECT id FROM downloads WHERE id = ?').get(id)).toBeUndefined();
    expect((await readdir(downloadRoot)).some((name) => name.startsWith('.vidharbor-delete-')))
      .toBe(false);
  });

  it('keeps a durable deleting record when hard-delete fails after archive removal', async () => {
    const filename = 'restore-me.webm';
    const outputPath = join(downloadRoot, filename);
    const id = await insertCompletedDownload(filename);
    database.exec(`
      CREATE TRIGGER reject_download_delete BEFORE DELETE ON downloads
      WHEN OLD.id = ${String(id)}
      BEGIN SELECT RAISE(ABORT, 'forced delete failure'); END
    `);

    const response = await request(`/downloads/${id}`, 'DELETE');

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PERSISTENCE_ERROR' },
    });
    // Archive is already gone; the durable deleting row remains for startup recovery.
    await expect(access(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      database.prepare('SELECT status FROM downloads WHERE id = ?').pluck().get(id),
    ).toBe('deleting');
    expect((await readdir(downloadRoot)).some((name) => name === '.vidharbor-delete'))
      .toBe(false);
  });

  it('keeps a completed record when its file is missing', async () => {
    const filename = 'already-missing.webm';
    const id = await insertCompletedDownload(filename);
    await rm(join(downloadRoot, filename));

    const response = await request(`/downloads/${id}`, 'DELETE');

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'DOWNLOAD_FILE_UNAVAILABLE' },
    });
    expect(database.prepare('SELECT id FROM downloads WHERE id = ?').pluck().get(id)).toBe(id);
  });

  it('retries a failed download with the fixed empty 202 response', async () => {
    const result = database
      .prepare(
        `INSERT INTO downloads (
          source_type, source_url, platform, platform_video_id, title,
          network_mode, status, failure_reason, created_at, finished_at
        ) VALUES ('direct', 'https://media.example/videos/retry', 'generic',
                  'retry', 'Retry', 'direct', 'failed', 'network error', ?, ?)`,
      )
      .run('2026-07-17T09:00:00.000Z', '2026-07-17T09:01:00.000Z');
    const id = Number(result.lastInsertRowid);

    const response = await request(`/downloads/${id}/retry`, 'POST', {});

    expect(response.status).toBe(202);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.text()).resolves.toBe('');
    expect(queued).toHaveLength(1);
    expect(database.prepare('SELECT status FROM downloads WHERE id = ?').pluck().get(id))
      .toBe('pending');
  });

  it('rejects active deletion and deletes a failed record without a file', async () => {
    const result = database
      .prepare(
        `INSERT INTO downloads (
          source_type, source_url, platform, platform_video_id, title,
          network_mode, status, created_at
        ) VALUES ('direct', 'https://media.example/videos/pending', 'generic',
                  'pending', 'Pending', 'direct', 'pending', ?)`,
      )
      .run('2026-07-17T09:00:00.000Z');
    const id = Number(result.lastInsertRowid);

    const activeResponse = await request(`/downloads/${id}`, 'DELETE');
    expect(activeResponse.status).toBe(400);
    await expect(activeResponse.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_ERROR' },
    });
    database
      .prepare(
        `UPDATE downloads
         SET status = 'failed', failure_reason = 'network error', finished_at = ?
         WHERE id = ?`,
      )
      .run('2026-07-17T09:01:00.000Z', id);

    const failedResponse = await request(`/downloads/${id}`, 'DELETE');
    expect(failedResponse.status).toBe(204);
    expect(database.prepare('SELECT id FROM downloads WHERE id = ?').get(id)).toBeUndefined();
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
