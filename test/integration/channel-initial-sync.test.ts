import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type DatabaseConnection } from '../../src/db/client.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { BusinessError } from '../../src/errors.js';
import {
  initialSyncChannel,
  saveChannel,
} from '../../src/services/channel.js';
import { CookieAuthorizationService } from '../../src/services/cookie-authorization.js';
import { YtDlpTaskManager } from '../../src/yt-dlp-task-manager.js';

const STARTED_AT = new Date('2026-07-17T08:30:00.000Z');
const DIRECT_URL = 'https://www.youtube.com/@direct';
const BILIBILI_CHANNEL_URL = 'https://space.bilibili.com/3985676';
const PROXY_URL = 'http://alice:secret@proxy.example:8080';

let sandbox: string;
let executablePath: string;
let database: DatabaseConnection;
let taskManager: YtDlpTaskManager;

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

function bilibiliMetadata(id: string, uploadDate: string): Record<string, unknown> {
  return {
    extractor_key: 'BiliBili',
    id,
    uploader_id: '3985676',
    title: `Bilibili ${id}`,
    upload_date: uploadDate,
    webpage_url: `https://www.bilibili.com/video/${id}`,
    duration: 10.2,
  };
}

const fixtureByUrl: Record<string, readonly Record<string, unknown>[]> = {
  'https://space.bilibili.com/3985676/video': [
    { _type: 'url', ie_key: 'BiliBili', id: 'BV13x41117TL', url: 'https://www.bilibili.com/video/BV13x41117TL' },
    { _type: 'url', ie_key: 'BilibiliCollectionList', id: '3985676_1', url: 'https://space.bilibili.com/3985676/lists/1?type=season' },
    { _type: 'url', ie_key: 'BiliBili', id: 'BV11x411K7CN', url: 'https://www.bilibili.com/video/BV11x411K7CN' },
    { _type: 'url', ie_key: 'BiliBili', id: 'BV1bK411W797', url: 'https://www.bilibili.com/video/BV1bK411W797' },
  ],
  'https://www.bilibili.com/video/BV13x41117TL': [
    bilibiliMetadata('BV13x41117TL', '20260716'),
  ],
  'https://www.bilibili.com/video/BV11x411K7CN': [
    bilibiliMetadata('BV11x411K7CN', '20250717'),
  ],
  'https://www.bilibili.com/video/BV1bK411W797': [
    bilibiliMetadata('BV1bK411W797', '20250716'),
  ],
  'https://www.youtube.com/@direct/videos': [
    metadata('bO_12-dA345', 'UC-direct', '20250717'),
    metadata('nE_12-wB345', 'UC-direct', '20260717'),
    metadata('oL_12-dC345', 'UC-direct', '20250716'),
    metadata('fU_12-tD345', 'UC-direct', '20260718'),
  ],
  'https://www.youtube.com/@proxy/videos': [
    metadata('pR_12-xY345', 'UC-proxy', '20260716'),
  ],
  'https://www.youtube.com/@detail/videos': [
    {
      ...metadata('dE_12-tA345', 'UC-detail', '20260716'),
      upload_date: undefined,
    },
  ],
  'https://www.youtube.com/watch?v=dE_12-tA345': [
    metadata('dE_12-tA345', 'UC-detail', '20260716'),
  ],
  'https://www.youtube.com/@duplicate/videos': [
    metadata('dU_12-pE345', 'UC-direct', '20260715'),
  ],
  'https://www.youtube.com/@invalid/videos': [
    metadata('vA_12-lD345', 'UC-invalid', '20260715'),
    { ...metadata('iN_12-vL345', 'UC-invalid', '20260714'), title: '' },
  ],
  'https://www.youtube.com/@mixed/videos': [
    metadata('mI_12-xA345', 'UC-mixed-a', '20260715'),
    metadata('mI_12-xB345', 'UC-mixed-b', '20260714'),
  ],
};

async function installFakeYtDlp(): Promise<void> {
  executablePath = join(sandbox, 'fake-yt-dlp.mjs');
  const fixtures = JSON.stringify(fixtureByUrl);
  await writeFile(
    executablePath,
    `#!/usr/bin/env node
const fixtures = ${fixtures};
const args = process.argv.slice(2);
const url = args.at(-1);
if (url === 'https://space.bilibili.com/3985676/video' && !args.includes('--flat-playlist')) process.exit(10);
if (url?.startsWith('https://www.bilibili.com/video/') && !args.includes('--no-playlist')) process.exit(11);
if (url === 'https://www.youtube.com/@failure/videos') {
  process.stderr.write('cannot use ${PROXY_URL} with alice:secret');
  process.exit(3);
}
if (url === 'https://www.youtube.com/@empty/videos') process.exit(0);
if (url === 'https://space.bilibili.com/999/video') process.exit(0);
if (url === 'https://www.youtube.com/@proxy/videos') {
  const index = args.indexOf('--proxy');
  if (index < 0 || args[index + 1] !== '${PROXY_URL}') process.exit(9);
}
for (const value of fixtures[url] ?? []) process.stdout.write(JSON.stringify(value) + '\\n');
`,
    'utf8',
  );
  await chmod(executablePath, 0o755);
}

function setGlobalInterval(minutes = 60): void {
  database
    .prepare(
      'UPDATE settings SET global_check_interval_minutes = ?, updated_at = ?',
    )
    .run(minutes, STARTED_AT.toISOString());
}

function createProxy(): number {
  const result = database
    .prepare(
      `INSERT INTO proxies (name, proxy_url, created_at, updated_at)
       VALUES ('office', ?, ?, ?)`,
    )
    .run(PROXY_URL, STARTED_AT.toISOString(), STARTED_AT.toISOString());
  return Number(result.lastInsertRowid);
}

function count(table: string): number {
  return database
    .prepare(`SELECT COUNT(*) FROM ${table}`)
    .pluck()
    .get() as number;
}

async function expectBusinessError(
  operation: Promise<unknown>,
  code: BusinessError['code'],
): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code });
}

async function createChannel(
  connection: DatabaseConnection,
  manager: YtDlpTaskManager,
  input: unknown,
  startedAt: Date,
  cookieAuthorizationService?: CookieAuthorizationService,
) {
  const channel = saveChannel(connection, input, startedAt);
  return initialSyncChannel(
    connection,
    manager,
    channel.id,
    { historyMonths: 12 },
    startedAt,
    cookieAuthorizationService,
  );
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'vidharbor-channel-sync-'));
  await installFakeYtDlp();
  database = openDatabase(join(sandbox, 'vidharbor.sqlite'));
  migrateDatabase(database);
  taskManager = new YtDlpTaskManager(executablePath, 1, (message) => message);
  setGlobalInterval();
});

afterEach(async () => {
  await taskManager.stop();
  try {
    database.close();
  } catch {
    // A persistence-boundary test may already have closed the connection.
  }
  await rm(sandbox, { recursive: true, force: true });
});

describe('channel initial synchronization', () => {
  it('synchronizes ordinary Bilibili UP submissions and excludes collections', async () => {
    const cookieAuthorizationService = new CookieAuthorizationService(
      join(sandbox, 'cookies'),
    );
    await cookieAuthorizationService.initialize();
    await cookieAuthorizationService.createConfiguration(
      'bilibili',
      Readable.from(['.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\ttest\n']),
    );
    const result = await createChannel(
      database,
      taskManager,
      {
        url: BILIBILI_CHANNEL_URL,
        customName: 'Bilibili UP',
        proxyId: null,
        authorizationPlatform: 'bilibili',
        checkIntervalMinutes: null,
      },
      STARTED_AT,
      cookieAuthorizationService,
    );

    expect(result).toMatchObject({
      channel: {
        platform: 'bilibili',
        extractor: 'BilibiliSpaceVideo',
        url: BILIBILI_CHANNEL_URL,
        authorizationPlatform: 'bilibili',
      },
      historicalVideoCount: 2,
    });
    expect(taskManager.getSnapshot().map((task) => task.type)).toEqual([
      'channel_initial_sync',
    ]);
    expect(database.prepare(
      `SELECT platform, platform_channel_id, authorization_platform
       FROM channels WHERE id = ?`,
    ).get(result.channel.id)).toEqual({
      platform: 'bilibili',
      platform_channel_id: '3985676',
      authorization_platform: 'bilibili',
    });
    expect(database.prepare(
      `SELECT platform, platform_video_id, published_date, duration_seconds
       FROM videos WHERE channel_id = ? ORDER BY published_date DESC`,
    ).all(result.channel.id)).toEqual([
      { platform: 'bilibili', platform_video_id: 'BV13x41117TL', published_date: '2026-07-16', duration_seconds: 11 },
      { platform: 'bilibili', platform_video_id: 'BV11x411K7CN', published_date: '2025-07-17', duration_seconds: 11 },
    ]);
    expect(count('notifications')).toBe(0);
  });

  it('keeps the Bilibili UP identity when the selected history is empty', async () => {
    const result = await createChannel(
      database,
      taskManager,
      {
        url: 'https://space.bilibili.com/999',
        customName: 'Empty Bilibili UP',
        proxyId: null,
        checkIntervalMinutes: null,
      },
      STARTED_AT,
    );

    expect(result).toMatchObject({
      channel: { platform: 'bilibili', initialSync: { status: 'succeeded' } },
      historicalVideoCount: 0,
    });
    expect(database.prepare(
      'SELECT platform_channel_id FROM channels WHERE id = ?',
    ).pluck().get(result.channel.id)).toBe('999');
  });


  it('commits one channel and only the inclusive one-year historical window without notifications', async () => {
    const result = await createChannel(
      database,
      taskManager,
      {
        url: DIRECT_URL,
        customName: 'Direct channel',
        proxyId: null,
        authorizationPlatform: null,
        checkIntervalMinutes: null,
      },
      STARTED_AT,
    );

    expect(result).toEqual({
      channel: {
        id: expect.any(Number),
        platform: 'youtube',
        extractor: 'YoutubeTab',
        url: DIRECT_URL,
        customName: 'Direct channel',
        proxyId: null,
        authorizationPlatform: null,
        checkIntervalMinutes: null,
        effectiveCheckIntervalMinutes: 60,
        pausedAt: null,
        initialSync: { status: 'succeeded', error: null },
        unreadNotificationCount: 0,
        lastCheck: { startedAt: null, nextAt: expect.any(String), result: null, error: null },
      },
      historicalVideoCount: 2,
    });
    expect(
      database
        .prepare(
          `SELECT platform_video_id, discovery_kind
           FROM videos ORDER BY platform_video_id`,
        )
        .all(),
    ).toEqual([
      { platform_video_id: 'bO_12-dA345', discovery_kind: 'historical' },
      { platform_video_id: 'nE_12-wB345', discovery_kind: 'historical' },
    ]);
    expect(count('notifications')).toBe(0);
    expect(database.prepare('SELECT * FROM channel_checks').get()).toMatchObject({
      kind: 'initial',
      channel_id: result.channel.id,
      requested_url: DIRECT_URL,
      started_at: STARTED_AT.toISOString(),
      finished_at: expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      ),
      result: 'success',
      new_video_count: 0,
      failure_reason: null,
    });
  });

  it('uses exactly the selected proxy and honors a channel interval override', async () => {
    const proxyId = createProxy();

    await expect(
      createChannel(
        database,
        taskManager,
        {
          url: 'https://www.youtube.com/@proxy',
          customName: 'Proxy channel',
          proxyId,
          checkIntervalMinutes: 15,
        },
        STARTED_AT,
      ),
    ).resolves.toMatchObject({
      channel: {
        proxyId,
        checkIntervalMinutes: 15,
        effectiveCheckIntervalMinutes: 15,
      },
      historicalVideoCount: 1,
    });
  });

  it('fetches video details when a channel list entry has no publish date', async () => {
    const result = await createChannel(
      database,
      taskManager,
      {
        url: 'https://www.youtube.com/@detail',
        customName: 'Detail channel',
        proxyId: null,
        checkIntervalMinutes: null,
      },
      STARTED_AT,
    );

    expect(result.historicalVideoCount).toBe(1);
    expect(
      database
        .prepare(
          `SELECT platform_video_id, published_date
           FROM videos WHERE channel_id = ?`,
        )
        .get(result.channel.id),
    ).toEqual({
      platform_video_id: 'dE_12-tA345',
      published_date: '2026-07-16',
    });
  });

  it('rejects missing global configuration and an unknown proxy before starting a check', async () => {
    database
      .prepare('UPDATE settings SET global_check_interval_minutes = NULL')
      .run();
    await expectBusinessError(
      createChannel(
        database,
        taskManager,
        {
          url: DIRECT_URL,
          customName: 'Channel',
          proxyId: null,
          checkIntervalMinutes: null,
        },
        STARTED_AT,
      ),
      'GLOBAL_INTERVAL_NOT_CONFIGURED',
    );
    expect(count('channel_checks')).toBe(0);

    setGlobalInterval();
    await expectBusinessError(
      createChannel(
        database,
        taskManager,
        {
          url: DIRECT_URL,
          customName: 'Channel',
          proxyId: 999,
          checkIntervalMinutes: null,
        },
        STARTED_AT,
      ),
      'PROXY_NOT_FOUND',
    );
    expect(count('channel_checks')).toBe(0);
  });

  it.each([
    ['https://www.youtube.com/@failure', 'CHANNEL_FETCH_FAILED'],
    ['https://www.youtube.com/@invalid', 'CHANNEL_METADATA_INVALID'],
    ['https://www.youtube.com/@mixed', 'CHANNEL_METADATA_INVALID'],
  ] as const)('keeps a retryable channel when %s fails with %s', async (url, code) => {
    const proxyId = url.endsWith('@failure') ? createProxy() : null;

    await expectBusinessError(
      createChannel(
        database,
        taskManager,
        {
          url,
          customName: `Failed ${code}`,
          proxyId,
          checkIntervalMinutes: null,
        },
        STARTED_AT,
      ),
      code,
    );

    expect(count('channels')).toBe(1);
    expect(count('videos')).toBe(0);
    expect(
      database.prepare('SELECT initial_sync_status FROM channels').pluck().get(),
    ).toBe('failed');
    const check = database.prepare('SELECT * FROM channel_checks').get() as {
      result: string;
      failure_reason: string;
    };
    expect(check.result).toBe('failed');
    expect(check.failure_reason).not.toContain('alice');
    expect(check.failure_reason).not.toContain('secret');
    expect(Buffer.byteLength(check.failure_reason, 'utf8')).toBeLessThanOrEqual(4096);
  });

  it('succeeds with an empty history when the selected range has no videos', async () => {
    const result = await createChannel(
      database,
      taskManager,
      {
        url: 'https://www.youtube.com/@empty',
        customName: 'Empty channel',
        proxyId: null,
        checkIntervalMinutes: null,
      },
      STARTED_AT,
    );

    expect(result.historicalVideoCount).toBe(0);
    expect(result.channel.initialSync).toEqual({ status: 'succeeded', error: null });
  });

  it('rejects a duplicate platform channel and a case-normalized name without partial writes', async () => {
    await createChannel(
      database,
      taskManager,
      {
        url: DIRECT_URL,
        customName: 'My Channel',
        proxyId: null,
        checkIntervalMinutes: null,
      },
      STARTED_AT,
    );

    await expectBusinessError(
      createChannel(
        database,
        taskManager,
        {
          url: 'https://www.youtube.com/@duplicate',
          customName: 'Another Channel',
          proxyId: null,
          checkIntervalMinutes: null,
        },
        STARTED_AT,
      ),
      'CHANNEL_ALREADY_EXISTS',
    );
    await expectBusinessError(
      createChannel(
        database,
        taskManager,
        {
          url: 'https://www.youtube.com/@proxy',
          customName: 'my channel',
          proxyId: null,
          checkIntervalMinutes: null,
        },
        STARTED_AT,
      ),
      'CHANNEL_NAME_EXISTS',
    );

    expect(count('channels')).toBe(2);
    expect(count('videos')).toBe(2);
    expect(count('notifications')).toBe(0);
  });

  it('rejects non-contract input without starting external work', async () => {
    await expectBusinessError(
      createChannel(
        database,
        taskManager,
        {
          url: DIRECT_URL,
          customName: 'Channel',
          proxyId: null,
          checkIntervalMinutes: null,
          extra: true,
        },
        STARTED_AT,
      ),
      'VALIDATION_ERROR',
    );
    expect(count('channel_checks')).toBe(0);
  });

  it('maps SQLite failures at the service boundary', async () => {
    database.close();

    await expectBusinessError(
      createChannel(
        database,
        taskManager,
        {
          url: DIRECT_URL,
          customName: 'Channel',
          proxyId: null,
          checkIntervalMinutes: null,
        },
        STARTED_AT,
      ),
      'PERSISTENCE_ERROR',
    );
  });
});
