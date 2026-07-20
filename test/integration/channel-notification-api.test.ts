import { access, chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApiRouter, createApp } from '../../src/app.js';
import { RuntimeCoordinator } from '../../src/runtime.js';
import { openDatabase, type DatabaseConnection } from '../../src/db/client.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { initialSyncChannel } from '../../src/services/channel.js';
import { YtDlpTaskManager } from '../../src/yt-dlp-task-manager.js';
import { isYtDlpTaskCancellationError } from '../../src/yt-dlp-task-cancellation.js';
import type { DownloadQueue } from '../../src/services/download.js';

const NOW = '2026-07-17T08:30:00.000Z';

function formatYtDlpDate(date: Date): string {
  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('');
}

function utcDateDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - days);
  return formatYtDlpDate(date);
}

function isoDateDaysAgo(days: number): string {
  const value = utcDateDaysAgo(days);
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

let sandbox: string;
let executablePath: string;
let database: DatabaseConnection;
let taskManager: YtDlpTaskManager;
let baseUrl: string;
let stopServer: (() => Promise<void>) | undefined;
let blockingSyncStartedPath: string;
let blockingSyncReleasePath: string;
let runtimeErrors: unknown[];

function metadata(
  id: string,
  channelId: string,
  uploadDate: string,
): Record<string, unknown> {
  return {
    extractor_key: 'Youtube',
    id,
    channel_id: channelId,
    title: `Video ${id}`,
    upload_date: uploadDate,
    webpage_url: `https://www.youtube.com/watch?v=${id}`,
    live_status: 'not_live',
  };
}

async function installFakeYtDlp(): Promise<void> {
  executablePath = join(sandbox, 'fake-yt-dlp.mjs');
  blockingSyncStartedPath = join(sandbox, 'blocking-sync.started');
  blockingSyncReleasePath = join(sandbox, 'blocking-sync.release');
  const fixtures = {
    'https://www.youtube.com/@first/videos': [
      metadata('fI_12-sT345', 'UC-first', utcDateDaysAgo(1)),
      metadata('fI_12-sT346', 'UC-first', utcDateDaysAgo(2)),
    ],
    'https://www.youtube.com/@second/videos': [
      metadata('sE_12-nD345', 'UC-second', utcDateDaysAgo(1)),
    ],
    'https://www.youtube.com/@blocking/videos': [
      metadata('bL_12-cK345', 'UC-blocking', utcDateDaysAgo(1)),
    ],
    'https://www.youtube.com/@blocking-metadata/videos': [{
      extractor_key: 'Youtube',
      id: 'mE_12-tA345',
      channel_id: 'UC-blocking-metadata',
      title: 'Video mE_12-tA345',
      webpage_url: 'https://www.youtube.com/watch?v=mE_12-tA345',
      live_status: 'not_live',
    }],
    'https://www.youtube.com/watch?v=mE_12-tA345': [
      metadata('mE_12-tA345', 'UC-blocking-metadata', utcDateDaysAgo(1)),
    ],
  };
  await writeFile(
    executablePath,
    `#!/usr/bin/env node
const fixtures = ${JSON.stringify(fixtures)};
const url = process.argv.at(-1);
if (
  url === 'https://www.youtube.com/@blocking/videos' ||
  url === 'https://www.youtube.com/watch?v=mE_12-tA345'
) {
  const { access, writeFile } = await import('node:fs/promises');
  await writeFile(${JSON.stringify(blockingSyncStartedPath)}, '');
  for (;;) {
    try { await access(${JSON.stringify(blockingSyncReleasePath)}); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
  }
}
if (url === 'https://www.youtube.com/@failure/videos') {
  process.stderr.write('fetch failed');
  process.exit(3);
}
for (const value of fixtures[url] ?? []) {
  process.stdout.write(JSON.stringify(value) + '\\n');
}
`,
    'utf8',
  );
  await chmod(executablePath, 0o755);
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await sleep(25);
    }
  }
  throw new Error(`file was not created: ${path}`);
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

async function waitForInitialSync(
  channelId: number,
  status: 'succeeded' | 'failed',
): Promise<{ initial_sync_status: string; initial_sync_error: string | null }> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const row = database
      .prepare('SELECT initial_sync_status, initial_sync_error FROM channels WHERE id = ?')
      .get(channelId) as {
        initial_sync_status: string;
        initial_sync_error: string | null;
      } | undefined;
    if (row?.initial_sync_status === status) return row;
    await sleep(25);
  }
  throw new Error(`channel initial synchronization did not reach ${status}`);
}

async function createChannel(
  url: string,
  customName: string,
): Promise<{ id: number }> {
  const response = await request('/channels', 'POST', {
    url,
    customName,
    proxyId: null,
    checkIntervalMinutes: null,
  });
  expect(response.status).toBe(201);
  const saved = (await response.json()) as { channel: { id: number } };
  const sync = await request(`/channels/${saved.channel.id}/initial-sync`, 'POST', {
    historyMonths: 12,
  });
  expect(sync.status).toBe(202);
  await expect(sync.json()).resolves.toEqual({ accepted: true });
  await waitForInitialSync(saved.channel.id, 'succeeded');
  return { id: saved.channel.id };
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'vidharbor-channel-api-'));
  await installFakeYtDlp();
  const mountPath = join(sandbox, 'downloads');
  await mkdir(mountPath);
  database = openDatabase(join(sandbox, 'vidharbor.sqlite'));
  migrateDatabase(database);
  taskManager = new YtDlpTaskManager(executablePath, 1, (message) => message);
  runtimeErrors = [];
  database
    .prepare(
      `UPDATE settings
       SET global_check_interval_minutes = 60, updated_at = ?
       WHERE id = 1`,
    )
    .run(NOW);

  const server = createApp(
    createApiRouter(
      database,
      mountPath,
      new RuntimeCoordinator((error) => runtimeErrors.push(error)),
      taskManager,
      {
        enqueue: () => undefined,
        cancel: async () => undefined,
      } satisfies DownloadQueue,
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
  await Promise.allSettled([taskManager.stop()]);
  try {
    database.close();
  } catch {
    // A persistence-boundary assertion may close the connection.
  }
  await rm(sandbox, { recursive: true, force: true });
});

describe('channel API', () => {
  it('accepts a canonical Bilibili UP space as a pending channel', async () => {
    const response = await request('/channels', 'POST', {
      url: 'https://space.bilibili.com/3985676',
      customName: 'Bilibili UP',
      proxyId: null,
      checkIntervalMinutes: null,
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      channel: {
        platform: 'bilibili',
        extractor: 'BilibiliSpaceVideo',
        url: 'https://space.bilibili.com/3985676',
        initialSync: { status: 'pending', error: null },
      },
    });
  });

  it('saves before manual synchronization, then lists and updates the channel', async () => {
    const createResponse = await request('/channels', 'POST', {
      url: 'https://www.youtube.com/@first',
      customName: 'First channel',
      proxyId: null,
      checkIntervalMinutes: null,
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { channel: { id: number; initialSync: unknown } };
    expect(created.channel.initialSync).toEqual({ status: 'pending', error: null });
    const first = { id: created.channel.id };
    const sync = await request(`/channels/${first.id}/initial-sync`, 'POST', { historyMonths: 12 });
    expect(sync.status).toBe(202);
    await expect(sync.json()).resolves.toEqual({ accepted: true });
    await waitForInitialSync(first.id, 'succeeded');

    const second = await createChannel('https://www.youtube.com/@second', 'Second channel');
    const listResponse = await request('/channels');
    expect(listResponse.status).toBe(200);
    const listed = (await listResponse.json()) as {
      items: Array<Record<string, unknown>>;
      pagination: Record<string, unknown>;
    };
    expect(listed.pagination).toEqual({ page: 1, pageSize: 20, totalItems: 2, totalPages: 1 });
    expect(listed.items).toHaveLength(2);
    expect(listed.items.map((channel) => channel.id)).toEqual([second.id, first.id]);
    expect(listed.items[1]).toEqual({
      id: first.id,
      platform: 'youtube',
      extractor: 'YoutubeTab',
      url: 'https://www.youtube.com/@first',
      customName: 'First channel',
      proxyId: null,
      checkIntervalMinutes: null,
      effectiveCheckIntervalMinutes: 60,
      pausedAt: null,
      initialSync: { status: 'succeeded', error: null },
      unreadNotificationCount: 0,
      lastCheck: { startedAt: null, nextAt: expect.any(String), result: null, error: null },
    });
    expect(Object.keys(listed.items[0] ?? {})).toEqual([
      'id',
      'platform',
      'extractor',
      'url',
      'customName',
      'proxyId',
      'checkIntervalMinutes',
      'effectiveCheckIntervalMinutes',
      'pausedAt',
      'initialSync',
      'unreadNotificationCount',
      'lastCheck',
    ]);

    const patchResponse = await request(
      `/channels/${first.id}`,
      'PATCH',
      {
        customName: 'Renamed channel',
        proxyId: null,
        checkIntervalMinutes: 15,
      },
    );
    expect(patchResponse.status).toBe(200);
    await expect(patchResponse.json()).resolves.toEqual({
      channel: {
        ...listed.items[1],
        customName: 'Renamed channel',
        checkIntervalMinutes: 15,
        effectiveCheckIntervalMinutes: 15,
      },
    });
  });

  it('rejects non-contract updates, missing dependencies, and name conflicts', async () => {
    const first = await createChannel(
      'https://www.youtube.com/@first',
      'First channel',
    );
    const second = await createChannel(
      'https://www.youtube.com/@second',
      'Second channel',
    );

    for (const body of [
      { customName: 'Partial' },
      {
        customName: 'Extra',
        proxyId: null,
        checkIntervalMinutes: null,
        url: 'https://www.youtube.com/@changed',
      },
    ]) {
      const response = await request(
        `/channels/${first.id}`,
        'PATCH',
        body,
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'VALIDATION_ERROR' },
      });
    }

    const missingProxy = await request(`/channels/${first.id}`, 'PATCH', {
      customName: 'First channel',
      proxyId: 999,
      checkIntervalMinutes: null,
    });
    expect(missingProxy.status).toBe(404);
    await expect(missingProxy.json()).resolves.toMatchObject({
      error: { code: 'PROXY_NOT_FOUND' },
    });

    const conflict = await request(`/channels/${second.id}`, 'PATCH', {
      customName: 'first channel',
      proxyId: null,
      checkIntervalMinutes: null,
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: 'CHANNEL_NAME_EXISTS' },
    });
  });

  it('stores a pending channel without starting initial synchronization', async () => {
    const response = await request('/channels', 'POST', {
      url: 'https://www.youtube.com/@failure',
      customName: 'Failed channel',
      proxyId: null,
      checkIntervalMinutes: null,
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      channel: { customName: 'Failed channel', initialSync: { status: 'pending', error: null } },
    });
    expect(
      database.prepare('SELECT COUNT(*) FROM channels').pluck().get(),
    ).toBe(1);
    expect(
      database.prepare('SELECT COUNT(*) FROM channel_checks').pluck().get(),
    ).toBe(0);
  });

  it('accepts initial synchronization before the external process finishes', async () => {
    const savedResponse = await request('/channels', 'POST', {
      url: 'https://www.youtube.com/@blocking',
      customName: 'Blocking channel',
      proxyId: null,
      checkIntervalMinutes: null,
    });
    const saved = (await savedResponse.json()) as { channel: { id: number } };

    const responsePromise = request(
      `/channels/${saved.channel.id}/initial-sync`,
      'POST',
      { historyMonths: 1 },
    );
    await waitForFile(blockingSyncStartedPath);
    let response: Response;
    try {
      response = await Promise.race([
        responsePromise,
        sleep(100).then(() => { throw new Error('initial sync response waited for yt-dlp'); }),
      ]);
    } finally {
      await writeFile(blockingSyncReleasePath, '');
    }

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true });
    await waitForInitialSync(saved.channel.id, 'succeeded');
    expect(taskManager.getSnapshot().at(-1)?.type).toBe('channel_initial_sync');
  });

  it('preserves typed cancellation while stopping initial-sync metadata loading', async () => {
    const savedResponse = await request('/channels', 'POST', {
      url: 'https://www.youtube.com/@blocking-metadata',
      customName: 'Canceled channel',
      proxyId: null,
      checkIntervalMinutes: null,
    });
    const saved = (await savedResponse.json()) as { channel: { id: number } };

    const synchronization = initialSyncChannel(
      database,
      taskManager,
      saved.channel.id,
      { historyMonths: 1 },
    ).catch((error: unknown) => error);
    await waitForFile(blockingSyncStartedPath);

    await expect(taskManager.stop()).resolves.toBeUndefined();
    expect(await synchronization).toSatisfy(isYtDlpTaskCancellationError);

    expect(taskManager.getSnapshot().at(-1)).toMatchObject({
      type: 'channel_initial_sync',
      status: 'canceled',
      failureReason: null,
    });
    expect(
      database
        .prepare('SELECT initial_sync_status FROM channels WHERE id = ?')
        .pluck()
        .get(saved.channel.id),
    ).toBe('failed');
    expect(runtimeErrors).toEqual([]);
  });

  it('waits for a manual check and records its fixed task type', async () => {
    const channel = await createChannel(
      'https://www.youtube.com/@first',
      'Manual check channel',
    );

    const response = await request(`/channels/${channel.id}/check`, 'POST', {});

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ newVideoCount: 0 });
    expect(taskManager.getSnapshot().at(-1)).toMatchObject({
      type: 'channel_manual_check',
      status: 'succeeded',
    });
  });

  it('accepts only the four initial history ranges and keeps failures retryable', async () => {
    const createResponse = await request('/channels', 'POST', {
      url: 'https://www.youtube.com/@failure',
      customName: 'Failed channel',
      proxyId: null,
      checkIntervalMinutes: null,
    });
    const created = (await createResponse.json()) as { channel: { id: number } };

    for (const historyMonths of [0, 2, 13, '1']) {
      const response = await request(
        `/channels/${created.channel.id}/initial-sync`,
        'POST',
        { historyMonths },
      );
      expect(response.status).toBe(400);
    }

    const failed = await request(
      `/channels/${created.channel.id}/initial-sync`,
      'POST',
      { historyMonths: 1 },
    );
    expect(failed.status).toBe(202);
    await expect(failed.json()).resolves.toEqual({ accepted: true });
    await waitForInitialSync(created.channel.id, 'failed');
    const list = (await (await request('/channels')).json()) as {
      items: Array<{ id: number; initialSync: { status: string; error: string | null } }>;
    };
    expect(list.items.find((channel) => channel.id === created.channel.id)?.initialSync)
      .toMatchObject({ status: 'failed', error: expect.any(String) });
    expect(runtimeErrors).toEqual([]);
  });

  it('reports an initial synchronization persistence failure during cancellation', async () => {
    const createResponse = await request('/channels', 'POST', {
      url: 'https://www.youtube.com/@blocking',
      customName: 'Persistence failure channel',
      proxyId: null,
      checkIntervalMinutes: null,
    });
    const created = (await createResponse.json()) as { channel: { id: number } };
    const response = await request(
      `/channels/${created.channel.id}/initial-sync`,
      'POST',
      { historyMonths: 1 },
    );
    expect(response.status).toBe(202);
    await waitForFile(blockingSyncStartedPath);

    database.close();
    const stopFailure = await taskManager.stop().catch((error: unknown) => error);
    expect(stopFailure).toBeInstanceOf(AggregateError);
    expect((stopFailure as AggregateError).errors).toEqual([
      expect.objectContaining({ code: 'PERSISTENCE_ERROR' }),
    ]);

    await expect.poll(() => runtimeErrors).toHaveLength(1);
    expect(runtimeErrors[0]).toMatchObject({ code: 'PERSISTENCE_ERROR' });
    expect(taskManager.getSnapshot().at(-1)).toMatchObject({
      type: 'channel_initial_sync',
      status: 'failed',
      failureReason: 'channel persistence failed',
    });
  });

  it('rejects invalid channel IDs and reports missing channels', async () => {
    for (const suffix of ['/channels/01/videos', '/channels/1.5/checks']) {
      const response = await request(suffix);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'VALIDATION_ERROR' },
      });
    }
    for (const suffix of ['/channels/999/videos', '/channels/999/checks']) {
      const response = await request(suffix);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'CHANNEL_NOT_FOUND' },
      });
    }
  });

  it('deletes a channel and its non-download history atomically', async () => {
    const { id } = await createChannel(
      'https://www.youtube.com/@first',
      'First channel',
    );
    const videoId = database
      .prepare('SELECT id FROM videos WHERE channel_id = ? LIMIT 1')
      .pluck()
      .get(id) as number;
    database
      .prepare('INSERT INTO notifications (video_id, created_at) VALUES (?, ?)')
      .run(videoId, '2026-07-18T10:00:00.000Z');

    expect((await request(`/channels/${id}`, 'DELETE')).status).toBe(204);
    for (const [table, column] of [
      ['channels', 'id'],
      ['videos', 'channel_id'],
      ['channel_checks', 'channel_id'],
    ] as const) {
      expect(
        database
          .prepare(`SELECT COUNT(*) FROM ${table} WHERE ${column} = ?`)
          .pluck()
          .get(id),
      ).toBe(0);
    }
    expect(
      database.prepare('SELECT COUNT(*) FROM notifications').pluck().get(),
    ).toBe(0);
  });

  it('rejects channel deletion when download records exist', async () => {
    const { id } = await createChannel(
      'https://www.youtube.com/@first',
      'First channel',
    );
    const video = database
      .prepare(
        `SELECT id, platform_video_id, source_url, title, published_date
         FROM videos WHERE channel_id = ? LIMIT 1`,
      )
      .get(id) as {
        id: number;
        platform_video_id: string;
        source_url: string;
        title: string;
        published_date: string;
      };
    database
      .prepare(
        `INSERT INTO downloads (
          source_type, channel_id, video_id, source_url, platform,
          platform_video_id, title, published_date, network_mode, status,
          created_at
        ) VALUES ('channel', ?, ?, ?, 'youtube', ?, ?, ?, 'direct', 'pending', ?)`,
      )
      .run(
        id,
        video.id,
        video.source_url,
        video.platform_video_id,
        video.title,
        video.published_date,
        '2026-07-18T10:00:00.000Z',
      );

    const response = await request(`/channels/${id}`, 'DELETE');
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'CHANNEL_IN_USE',
        message: 'channel has download records',
      },
    });
    expect(
      database.prepare('SELECT COUNT(*) FROM channels WHERE id = ?').pluck().get(id),
    ).toBe(1);
    expect(
      database.prepare('SELECT COUNT(*) FROM videos WHERE channel_id = ?').pluck().get(id),
    ).toBeGreaterThan(0);
  });

  it('rejects channel deletion while a check is running', async () => {
    const { id } = await createChannel(
      'https://www.youtube.com/@first',
      'First channel',
    );
    database
      .prepare(
        `INSERT INTO channel_checks (
          kind, channel_id, requested_url, started_at
        ) VALUES ('scheduled', ?, ?, ?)`,
      )
      .run(
        id,
        'https://www.youtube.com/@first',
        '2026-07-18T10:00:00.000Z',
      );

    const response = await request(`/channels/${id}`, 'DELETE');
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'CHANNEL_IN_USE',
        message: 'channel check is running',
      },
    });
    expect(
      database.prepare('SELECT COUNT(*) FROM channels WHERE id = ?').pluck().get(id),
    ).toBe(1);
  });

  it('reports missing channel deletion and keeps the unconfirmed checks action absent', async () => {
    const missing = await request('/channels/999', 'DELETE');
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: 'CHANNEL_NOT_FOUND' },
    });
    expect(
      (
        await request('/channels/999/checks', 'POST', {})
      ).status,
    ).toBe(404);
  });
});

describe('video, check, and notification API', () => {
  it('returns only fixed response fields in the required descending order', async () => {
    const { id: channelId } = await createChannel(
      'https://www.youtube.com/@first',
      'First channel',
    );
    const videos = database
      .prepare('SELECT id FROM videos WHERE channel_id = ? ORDER BY id')
      .pluck()
      .all(channelId) as number[];
    const newerPublishedVideoId = videos[0] as number;
    const olderPublishedVideoId = videos[1] as number;
    const pendingDownloadId = Number(database
      .prepare(
        `INSERT INTO downloads (
          source_type, channel_id, video_id, source_url, platform,
          platform_video_id, title, published_date, network_mode,
          status, created_at
        )
        SELECT 'channel', v.channel_id, v.id, v.source_url, v.platform,
               v.platform_video_id, v.title, v.published_date, 'direct',
               'pending', ?
        FROM videos v WHERE v.id = ?`,
      )
      .run('2026-07-17T10:00:00.000Z', newerPublishedVideoId).lastInsertRowid);

    const failedCheckId = Number(database
      .prepare(
        `INSERT INTO channel_checks (
          kind, channel_id, requested_url, started_at, finished_at,
          result, new_video_count, failure_reason
        ) VALUES ('scheduled', ?, 'https://www.youtube.com/@first', ?, ?, 'failed', 0, 'network failed')`,
      )
      .run(
        channelId,
        '2099-07-18T08:00:00.000Z',
        '2099-07-18T08:01:00.000Z',
      ).lastInsertRowid);
    const noUpdateCheckId = Number(database
      .prepare(
        `INSERT INTO channel_checks (
          kind, channel_id, requested_url, started_at, finished_at,
          result, new_video_count, failure_reason
        ) VALUES ('scheduled', ?, 'https://www.youtube.com/@first', ?, ?, 'no_updates', 0, NULL)`,
      )
      .run(
        channelId,
        '2099-07-18T08:00:00.000Z',
        '2099-07-18T08:02:00.000Z',
      ).lastInsertRowid);
    database
      .prepare(
        `INSERT INTO notifications (video_id, created_at) VALUES (?, ?), (?, ?)` ,
      )
      .run(
        newerPublishedVideoId,
        '2026-07-18T09:00:00.000Z',
        olderPublishedVideoId,
        '2026-07-18T09:00:00.000Z',
      );

    const videoResponse = await request(`/channels/${channelId}/videos`);
    expect(videoResponse.status).toBe(200);
    const videoBody = (await videoResponse.json()) as {
      items: Array<Record<string, unknown>>;
      pagination: Record<string, unknown>;
    };
    expect(videoBody.pagination).toEqual({ page: 1, pageSize: 20, totalItems: 2, totalPages: 1 });
    expect(videoBody.items.map((item) => item.id)).toEqual([
      newerPublishedVideoId,
      olderPublishedVideoId,
    ]);
    expect(videoBody.items[0]).toEqual({
      id: newerPublishedVideoId,
      title: 'Video fI_12-sT345',
      publishedDate: isoDateDaysAgo(1),
      url: 'https://www.youtube.com/watch?v=fI_12-sT345',
      durationSeconds: null,
      thumbnailUrl: null,
      downloadId: pendingDownloadId,
      downloadStatus: 'pending',
      downloadFinishedAt: null,
      downloadOutputSizeBytes: null,
      downloadFailureReason: null,
    });

    const checksResponse = await request(`/channels/${channelId}/checks`);
    expect(checksResponse.status).toBe(200);
    const checksBody = (await checksResponse.json()) as {
      items: Array<Record<string, unknown>>;
      pagination: Record<string, unknown>;
    };
    expect(checksBody.pagination).toEqual({ page: 1, pageSize: 20, totalItems: 3, totalPages: 1 });
    expect(checksBody.items.slice(0, 2).map((item) => item.id)).toEqual([
      noUpdateCheckId,
      failedCheckId,
    ]);
    expect(checksBody.items[1]).toEqual({
      id: failedCheckId,
      kind: 'scheduled',
      startedAt: '2099-07-18T08:00:00.000Z',
      finishedAt: '2099-07-18T08:01:00.000Z',
      result: 'failed',
      newVideoCount: 0,
      failureReason: 'network failed',
    });

    const notificationsResponse = await request('/notifications');
    expect(notificationsResponse.status).toBe(200);
    const notifications = (await notificationsResponse.json()) as {
      items: Array<Record<string, unknown>>;
      pagination: Record<string, unknown>;
      unreadCount: number;
    };
    expect(notifications.pagination).toEqual({ page: 1, pageSize: 20, totalItems: 2, totalPages: 1 });
    expect(notifications.unreadCount).toBe(2);
    expect(notifications.items.map((item) => item.id)).toEqual([2, 1]);
    expect(notifications.items[0]).toEqual({
      id: 2,
      createdAt: '2026-07-18T09:00:00.000Z',
      readAt: null,
      channel: { id: channelId, customName: 'First channel' },
      video: {
        id: olderPublishedVideoId,
        title: 'Video fI_12-sT346',
        publishedDate: isoDateDaysAgo(2),
        url: 'https://www.youtube.com/watch?v=fI_12-sT346',
      },
    });
    const readAll = await request('/notifications/read-all', 'POST', {});
    expect(readAll.status).toBe(200);
    await expect(readAll.json()).resolves.toEqual({ changed: 2 });
    const afterReadAll = await request('/notifications?page=1');
    await expect(afterReadAll.json()).resolves.toMatchObject({ unreadCount: 0 });

    expect((await request('/notifications/1', 'PATCH', {})).status).toBe(404);
    expect((await request('/notifications/1', 'DELETE')).status).toBe(404);

    const filteredVideos = await request(`/channels/${channelId}/videos?page=1&q=${encodeURIComponent('fI_12-sT345')}`);
    await expect(filteredVideos.json()).resolves.toMatchObject({
      items: [{ id: newerPublishedVideoId }],
      pagination: { totalItems: 1 },
    });
    for (const path of [
      '/channels?page=999',
      `/channels/${channelId}/videos?page=999`,
      `/channels/${channelId}/checks?page=999`,
      '/notifications?page=999',
    ]) {
      const response = await request(path);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        items: [],
        pagination: { page: 999 },
      });
    }
    for (const path of [
      '/channels?page=0',
      `/channels/${channelId}/videos?page=x`,
      `/channels/${channelId}/checks?page=1.5`,
      '/notifications?page=-1',
    ]) {
      const response = await request(path);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
  });
});
