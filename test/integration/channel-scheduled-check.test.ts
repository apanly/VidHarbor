import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type DatabaseConnection } from '../../src/db/client.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { BusinessError } from '../../src/errors.js';
import {
  checkChannel,
  checkScheduledChannel,
} from '../../src/services/channel.js';
import { CookieAuthorizationService } from '../../src/services/cookie-authorization.js';
import { listNotifications } from '../../src/services/notification.js';
import { YtDlpTaskManager } from '../../src/yt-dlp-task-manager.js';

const FIRST_STARTED_AT = new Date('2026-07-17T08:30:00.000Z');
const SECOND_STARTED_AT = new Date('2026-07-17T09:30:00.000Z');
const PROXY_URL = 'http://alice:secret@proxy.example:8080';
const COOKIE_VALUE_MARKER = 'task-09-cookie-value';
const VALID_COOKIE_FILE = Buffer.from(
  `.youtube.com\tTRUE\t/\tTRUE\t0\ttask09\t${COOKIE_VALUE_MARKER}\n`,
);

interface YtDlpInvocation {
  readonly args: string[];
  readonly cookieArgumentReference: boolean;
  readonly cookieValueArgumentReference: boolean;
  readonly cookieStorageArgumentReference: boolean;
  readonly cookieEnvironmentNameReference: boolean;
  readonly cookieEnvironmentReference: boolean;
}

let sandbox: string;
let executablePath: string;
let database: DatabaseConnection;
let taskManager: YtDlpTaskManager;

function metadata(
  id: string,
  channelId: string,
  uploadDate: string,
  title = `Video ${id}`,
): Record<string, unknown> {
  return {
    extractor_key: 'Youtube',
    id,
    channel_id: channelId,
    title,
    upload_date: uploadDate,
    webpage_url: `https://www.youtube.com/watch?v=${id}`,
    live_status: 'not_live',
  };
}

const fixtures: Record<string, readonly Record<string, unknown>[]> = {
  'https://space.bilibili.com/3985676/video': [
    { _type: 'url', ie_key: 'BiliBili', id: 'BV13x41117TL', url: 'https://www.bilibili.com/video/BV13x41117TL' },
    { _type: 'url', ie_key: 'BiliBili', id: 'BV11x411K7CN', url: 'https://www.bilibili.com/video/BV11x411K7CN' },
  ],
  'https://www.bilibili.com/video/BV13x41117TL': [{
    extractor_key: 'BiliBili', id: 'BV13x41117TL', uploader_id: '3985676',
    title: 'New Bilibili video', upload_date: '20260716',
    webpage_url: 'https://www.bilibili.com/video/BV13x41117TL',
  }],
  'https://www.bilibili.com/video/BV11x411K7CN': [{
    extractor_key: 'BiliBili', id: 'BV11x411K7CN', uploader_id: '3985676',
    title: 'Old Bilibili video', upload_date: '20260616',
    webpage_url: 'https://www.bilibili.com/video/BV11x411K7CN',
  }],
  'https://www.youtube.com/@updates/videos': [
    metadata('oL_12-dA345', 'UC-updates', '20260716', 'Changed existing title'),
    metadata('nE_12-wB345', 'UC-updates', '20260717'),
    metadata('nE_12-wC345', 'UC-updates', '20260617'),
    metadata('oL_12-dD345', 'UC-updates', '20250716'),
  ],
  'https://www.youtube.com/@stable/videos': [
    metadata('sT_12-bL345', 'UC-stable', '20260716'),
  ],
  'https://www.youtube.com/@invalid/videos': [
    { ...metadata('iN_12-vL345', 'UC-invalid', '20260716'), live_status: 'is_upcoming' },
  ],
  'https://www.youtube.com/@old-only/videos': [
    metadata('oL_12-oN345', 'UC-old-only', '20260616'),
  ],
};

async function installFakeYtDlp(): Promise<void> {
  executablePath = join(sandbox, 'fake-yt-dlp.mjs');
  const invocationLogPath = JSON.stringify(join(sandbox, 'argv.log'));
  const cookieStorageDirectory = JSON.stringify(join(sandbox, 'cookies'));
  await writeFile(
    executablePath,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

const fixtures = ${JSON.stringify(fixtures)};
const args = process.argv.slice(2);
const url = args.at(-1);
const cookieArgumentReference = args.some((argument) =>
  argument === '--cookies' || argument.startsWith('--cookies=') ||
  argument === '--cookies-from-browser' || argument.startsWith('--cookies-from-browser=') ||
  /^cookie:/iu.test(argument)
);
const cookieValueArgumentReference = args.some((argument) =>
  argument.includes(${JSON.stringify(COOKIE_VALUE_MARKER)})
);
const cookieStorageArgumentReference = args.some((argument) =>
  argument.includes(${cookieStorageDirectory})
);
const sanitizedArgs = args.filter((argument, index) => {
  const previous = args[index - 1];
  return argument !== '--cookies' && !argument.startsWith('--cookies=') &&
    argument !== '--cookies-from-browser' && !argument.startsWith('--cookies-from-browser=') &&
    previous !== '--cookies' && previous !== '--cookies-from-browser' &&
    !/^cookie:/iu.test(argument) &&
    !argument.includes(${JSON.stringify(COOKIE_VALUE_MARKER)}) &&
    !argument.includes(${cookieStorageDirectory});
});
const cookieEnvironmentNameReference = Object.keys(process.env).some((name) =>
  /cookie/iu.test(name)
);
const cookieEnvironmentReference = Object.values(process.env).some((value) =>
  value?.includes(${JSON.stringify(COOKIE_VALUE_MARKER)}) ||
  value?.includes(${cookieStorageDirectory})
);
appendFileSync(${invocationLogPath}, JSON.stringify({ args: sanitizedArgs, cookieArgumentReference, cookieValueArgumentReference, cookieStorageArgumentReference, cookieEnvironmentNameReference, cookieEnvironmentReference }) + '\\n');
const dateAfterIndex = args.indexOf('--dateafter');
const dateAfter = dateAfterIndex === -1 ? undefined : args[dateAfterIndex + 1];
if (url === 'https://www.youtube.com/@failure/videos') {
  process.stderr.write('cannot use ${PROXY_URL} with alice:secret');
  process.exit(3);
}
if (url === 'https://www.youtube.com/@observe/videos') {
  const marker = process.env.VIDHARBOR_TEST_MARKER;
  const release = process.env.VIDHARBOR_TEST_RELEASE;
  writeFileSync(marker, 'started');
  while (!existsSync(release)) {}
  process.stdout.write(JSON.stringify(${JSON.stringify(metadata('oB_12-sE345', 'UC-observe', '20260717'))}) + '\\n');
  process.exit(0);
}
const values = (fixtures[url] ?? []).filter((value) => dateAfter === undefined || value.upload_date >= dateAfter);
if (dateAfter !== undefined && values.length === 0) process.exit(101);
for (const value of values) {
  process.stdout.write(JSON.stringify(value) + '\\n');
}
`,
    'utf8',
  );
  await chmod(executablePath, 0o755);
}

async function readYtDlpInvocations(): Promise<YtDlpInvocation[]> {
  return (await readFile(join(sandbox, 'argv.log'), 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as YtDlpInvocation);
}

function expectNoCookieReferences(invocation: YtDlpInvocation): void {
  expect(invocation.cookieArgumentReference).toBe(false);
  expect(invocation.cookieValueArgumentReference).toBe(false);
  expect(invocation.cookieStorageArgumentReference).toBe(false);
  expect(invocation.cookieEnvironmentNameReference).toBe(false);
  expect(invocation.cookieEnvironmentReference).toBe(false);
}

function insertChannel(
  handle: string,
  platformChannelId: string,
  proxyId: number | null = null,
): number {
  const url = `https://www.youtube.com/@${handle}`;
  const result = database
    .prepare(
      `INSERT INTO channels (
        platform, platform_channel_id, source_url, custom_name,
        custom_name_key, proxy_id, check_interval_minutes,
        initial_synced_at, created_at, updated_at
      ) VALUES ('youtube', ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(
      platformChannelId,
      url,
      `${handle} channel`,
      `${handle} channel`,
      proxyId,
      FIRST_STARTED_AT.toISOString(),
      FIRST_STARTED_AT.toISOString(),
      FIRST_STARTED_AT.toISOString(),
    );
  return Number(result.lastInsertRowid);
}

function insertHistoricalVideo(
  channelId: number,
  platformVideoId: string,
  title: string,
  publishedDate: string,
  url: string,
): number {
  const result = database
    .prepare(
      `INSERT INTO videos (
        channel_id, platform, platform_video_id, title, published_date,
        source_url, discovery_kind, discovered_at
      ) VALUES (?, 'youtube', ?, ?, ?, ?, 'historical', ?)`,
    )
    .run(
      channelId,
      platformVideoId,
      title,
      publishedDate,
      url,
      FIRST_STARTED_AT.toISOString(),
    );
  return Number(result.lastInsertRowid);
}

function insertBilibiliChannel(): number {
  const result = database.prepare(
    `INSERT INTO channels (
      platform, extractor, platform_channel_id, source_url, custom_name,
      custom_name_key, proxy_id, check_interval_minutes,
      initial_synced_at, created_at, updated_at
    ) VALUES ('bilibili', 'BilibiliSpaceVideo', '3985676',
      'https://space.bilibili.com/3985676', 'Bilibili UP', 'bilibili up',
      NULL, NULL, ?, ?, ?)`,
  ).run(
    FIRST_STARTED_AT.toISOString(),
    FIRST_STARTED_AT.toISOString(),
    FIRST_STARTED_AT.toISOString(),
  );
  return Number(result.lastInsertRowid);
}

function createProxy(): number {
  const result = database
    .prepare(
      `INSERT INTO proxies (name, proxy_url, created_at, updated_at)
       VALUES ('office', ?, ?, ?)`,
    )
    .run(
      PROXY_URL,
      FIRST_STARTED_AT.toISOString(),
      FIRST_STARTED_AT.toISOString(),
    );
  return Number(result.lastInsertRowid);
}

async function expectBusinessError(
  operation: Promise<unknown>,
  code: BusinessError['code'],
): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code });
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await import('node:fs/promises').then(({ access }) => access(path));
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'vidharbor-scheduled-check-'));
  await installFakeYtDlp();
  database = openDatabase(join(sandbox, 'vidharbor.sqlite'));
  migrateDatabase(database);
  taskManager = new YtDlpTaskManager(executablePath, 1, (message) => message);
  const cookieAuthorizationService = new CookieAuthorizationService(
    join(sandbox, 'cookies'),
  );
  await cookieAuthorizationService.initialize();
  expect(taskManager.getSnapshot()).toEqual([]);
  await cookieAuthorizationService.saveConfiguration(
    'youtube',
    Readable.from([VALID_COOKIE_FILE]),
  );
  expect(taskManager.getSnapshot()).toEqual([]);
});

afterEach(async () => {
  delete process.env.VIDHARBOR_TEST_MARKER;
  delete process.env.VIDHARBOR_TEST_RELEASE;
  await taskManager.stop();
  try {
    database.close();
  } catch {
    // A persistence-boundary test may already have closed the connection.
  }
  await rm(sandbox, { recursive: true, force: true });
});

describe('scheduled channel checks', () => {
  it('keeps a saved Cookie out of manual and scheduled check invocations', async () => {
    const channelId = insertChannel('stable', 'UC-stable');

    await expect(
      checkChannel(database, taskManager, channelId, FIRST_STARTED_AT),
    ).resolves.toEqual({ newVideoCount: 1 });
    await expect(
      checkScheduledChannel(database, taskManager, channelId, SECOND_STARTED_AT),
    ).resolves.toEqual({ newVideoCount: 0 });

    expect(taskManager.getSnapshot().map((task) => task.type)).toEqual([
      'channel_manual_check',
      'channel_scheduled_check',
    ]);
    const invocations = await readYtDlpInvocations();
    expect(invocations).toHaveLength(2);
    for (const invocation of invocations) {
      expectNoCookieReferences(invocation);
      expect(invocation.args).toContain('--dateafter');
    }
  });

  it('discovers recent Bilibili submissions and stops at the one-month boundary', async () => {
    const channelId = insertBilibiliChannel();

    await expect(
      checkScheduledChannel(database, taskManager, channelId, FIRST_STARTED_AT),
    ).resolves.toEqual({ newVideoCount: 1 });
    expect(taskManager.getSnapshot().map((task) => task.type)).toEqual([
      'channel_scheduled_check',
    ]);

    expect(database.prepare(
      `SELECT platform, platform_video_id, title FROM videos WHERE channel_id = ?`,
    ).all(channelId)).toEqual([{
      platform: 'bilibili',
      platform_video_id: 'BV13x41117TL',
      title: 'New Bilibili video',
    }]);
    expect(database.prepare('SELECT COUNT(*) FROM notifications').pluck().get()).toBe(1);
  });

  it('atomically saves unseen videos and one notification for each without changing existing metadata', async () => {
    const channelId = insertChannel('updates', 'UC-updates');
    const existingUrl = 'https://www.youtube.com/watch?v=oL_12-dA345';
    const existingId = insertHistoricalVideo(
      channelId,
      'oL_12-dA345',
      'Original title',
      '2026-07-01',
      existingUrl,
    );

    await expect(
      checkScheduledChannel(database, taskManager, channelId, FIRST_STARTED_AT),
    ).resolves.toEqual({ newVideoCount: 2 });

    expect(
      database
        .prepare(
          `SELECT platform_video_id, title, published_date, source_url, discovery_kind
           FROM videos ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        platform_video_id: 'oL_12-dA345',
        title: 'Original title',
        published_date: '2026-07-01',
        source_url: existingUrl,
        discovery_kind: 'historical',
      },
      {
        platform_video_id: 'nE_12-wB345',
        title: 'Video nE_12-wB345',
        published_date: '2026-07-17',
        source_url: 'https://www.youtube.com/watch?v=nE_12-wB345',
        discovery_kind: 'new',
      },
      {
        platform_video_id: 'nE_12-wC345',
        title: 'Video nE_12-wC345',
        published_date: '2026-06-17',
        source_url: 'https://www.youtube.com/watch?v=nE_12-wC345',
        discovery_kind: 'new',
      },
    ]);
    expect(
      database.prepare('SELECT video_id FROM notifications ORDER BY id').all(),
    ).toEqual([
      { video_id: existingId + 1 },
      { video_id: existingId + 2 },
    ]);
    expect(database.prepare('SELECT * FROM channel_checks').get()).toMatchObject({
      kind: 'scheduled',
      channel_id: channelId,
      requested_url: 'https://www.youtube.com/@updates',
      started_at: FIRST_STARTED_AT.toISOString(),
      result: 'success',
      new_video_count: 2,
      failure_reason: null,
    });
    expect(
      database.prepare('SELECT last_check_started_at, last_check_result, last_check_error FROM channels WHERE id = ?').get(channelId),
    ).toEqual({
      last_check_started_at: FIRST_STARTED_AT.toISOString(),
      last_check_result: 'success',
      last_check_error: null,
    });

    expect(listNotifications(database)).toEqual([
      {
        id: 2,
        createdAt: expect.any(String),
        readAt: null,
        channel: { id: channelId, customName: 'updates channel' },
        video: {
          id: existingId + 2,
          title: 'Video nE_12-wC345',
          publishedDate: '2026-06-17',
          url: 'https://www.youtube.com/watch?v=nE_12-wC345',
        },
      },
      {
        id: 1,
        createdAt: expect.any(String),
        readAt: null,
        channel: { id: channelId, customName: 'updates channel' },
        video: {
          id: existingId + 1,
          title: 'Video nE_12-wB345',
          publishedDate: '2026-07-17',
          url: 'https://www.youtube.com/watch?v=nE_12-wB345',
        },
      },
    ]);
  });

  it('records no_updates and creates no duplicate videos or notifications', async () => {
    const channelId = insertChannel('stable', 'UC-stable');
    insertHistoricalVideo(
      channelId,
      'sT_12-bL345',
      'Stored title',
      '2026-07-16',
      'https://www.youtube.com/watch?v=sT_12-bL345',
    );

    await expect(
      checkScheduledChannel(database, taskManager, channelId, SECOND_STARTED_AT),
    ).resolves.toEqual({ newVideoCount: 0 });

    expect(database.prepare('SELECT COUNT(*) FROM videos').pluck().get()).toBe(1);
    expect(database.prepare('SELECT COUNT(*) FROM notifications').pluck().get()).toBe(0);
    expect(database.prepare('SELECT result, new_video_count FROM channel_checks').get()).toEqual({
      result: 'no_updates',
      new_video_count: 0,
    });
    expect(database.prepare('SELECT last_check_started_at, last_check_result FROM channels WHERE id = ?').get(channelId)).toEqual({
      last_check_started_at: SECOND_STARTED_AT.toISOString(),
      last_check_result: 'no_updates',
    });
  });

  it('treats a channel with no videos in the latest month as no_updates', async () => {
    const channelId = insertChannel('old-only', 'UC-old-only');

    await expect(
      checkScheduledChannel(database, taskManager, channelId, FIRST_STARTED_AT),
    ).resolves.toEqual({ newVideoCount: 0 });

    expect(database.prepare('SELECT COUNT(*) FROM videos').pluck().get()).toBe(0);
    expect(database.prepare('SELECT COUNT(*) FROM notifications').pluck().get()).toBe(0);
    expect(database.prepare('SELECT result, new_video_count FROM channel_checks').get()).toEqual({
      result: 'no_updates',
      new_video_count: 0,
    });
  });

  it('rolls back a new video when its notification cannot be inserted', async () => {
    const channelId = insertChannel('stable', 'UC-stable');
    database.exec(
      `CREATE TRIGGER reject_notification
       BEFORE INSERT ON notifications
       BEGIN
         SELECT RAISE(ABORT, 'notification rejected');
       END`,
    );

    await expectBusinessError(
      checkScheduledChannel(database, taskManager, channelId, SECOND_STARTED_AT),
      'PERSISTENCE_ERROR',
    );

    expect(database.prepare('SELECT COUNT(*) FROM videos').pluck().get()).toBe(0);
    expect(database.prepare('SELECT COUNT(*) FROM notifications').pluck().get()).toBe(0);
    expect(database.prepare('SELECT result, new_video_count FROM channel_checks').get()).toEqual({
      result: 'failed',
      new_video_count: 0,
    });
    expect(database.prepare('SELECT last_check_result FROM channels WHERE id = ?').pluck().get(channelId)).toBe('failed');
  });

  it.each([
    ['failure', 'UC-failure', 'CHANNEL_FETCH_FAILED'],
    ['invalid', 'UC-invalid', 'CHANNEL_METADATA_INVALID'],
  ] as const)('isolates %s failure and records the channel as failed', async (handle, platformChannelId, code) => {
    const stableChannelId = insertChannel('stable', 'UC-stable');
    const proxyId = handle === 'failure' ? createProxy() : null;
    const failedChannelId = insertChannel(handle, platformChannelId, proxyId);
    insertHistoricalVideo(
      failedChannelId,
      'fA_12-lD345',
      'Preserved video',
      '2026-07-10',
      'https://www.youtube.com/watch?v=fA_12-lD345',
    );

    await expectBusinessError(
      checkScheduledChannel(database, taskManager, failedChannelId, SECOND_STARTED_AT),
      code,
    );

    expect(database.prepare('SELECT COUNT(*) FROM videos').pluck().get()).toBe(1);
    expect(database.prepare('SELECT COUNT(*) FROM notifications').pluck().get()).toBe(0);
    expect(database.prepare('SELECT result, new_video_count, failure_reason FROM channel_checks').get()).toMatchObject({
      result: 'failed',
      new_video_count: 0,
      failure_reason: expect.any(String),
    });
    const failed = database.prepare('SELECT last_check_started_at, last_check_result, last_check_error FROM channels WHERE id = ?').get(failedChannelId) as {
      last_check_started_at: string;
      last_check_result: string;
      last_check_error: string;
    };
    expect(failed).toMatchObject({
      last_check_started_at: SECOND_STARTED_AT.toISOString(),
      last_check_result: 'failed',
      last_check_error: expect.any(String),
    });
    expect(failed.last_check_error).not.toContain('alice');
    expect(failed.last_check_error).not.toContain('secret');
    expect(database.prepare('SELECT last_check_started_at FROM channels WHERE id = ?').pluck().get(stableChannelId)).toBeNull();
  });

  it('commits the scheduled check and startedAt before invoking the external process', async () => {
    const channelId = insertChannel('observe', 'UC-observe');
    const marker = join(sandbox, 'process-started');
    const release = join(sandbox, 'process-release');
    process.env.VIDHARBOR_TEST_MARKER = marker;
    process.env.VIDHARBOR_TEST_RELEASE = release;

    const operation = checkScheduledChannel(
      database,
      taskManager,
      channelId,
      SECOND_STARTED_AT,
    );
    await waitForFile(marker);

    expect(database.prepare('SELECT kind, started_at, result FROM channel_checks').get()).toEqual({
      kind: 'scheduled',
      started_at: SECOND_STARTED_AT.toISOString(),
      result: null,
    });
    expect(database.prepare('SELECT last_check_started_at FROM channels WHERE id = ?').pluck().get(channelId)).toBe(SECOND_STARTED_AT.toISOString());

    await writeFile(release, 'continue', 'utf8');
    await expect(operation).resolves.toEqual({ newVideoCount: 1 });
  });
});
