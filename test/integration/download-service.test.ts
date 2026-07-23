import { chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type DatabaseConnection } from '../../src/db/client.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { BusinessError } from '../../src/errors.js';
import {
  createChannelDownloads,
  createDirectDownload,
  cancelDownload,
  getDownloadFile,
  retryDownload,
  type DownloadQueue,
  type QueuedDownload,
} from '../../src/services/download.js';
import { YtDlpTaskManager } from '../../src/yt-dlp-task-manager.js';

const NOW = new Date('2026-07-17T11:20:00.000Z');
const PROXY_URL = 'http://alice:secret@proxy.example:8080';
const FIRST_VIDEO_ID = 'aB_12-cD345';
const SECOND_VIDEO_ID = 'eF_67-gH890';
const GENERIC_VIDEO_ID = 'generic-123456789';
const GENERIC_VIDEO_URL = `https://media.example/videos/${GENERIC_VIDEO_ID}`;

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
let downloadRoot: string;
let executablePath: string;
let database: DatabaseConnection;
let queued: QueuedDownload[];
let queue: DownloadQueue;
let taskManager: YtDlpTaskManager;

async function installFakeYtDlp(): Promise<void> {
  executablePath = join(sandbox, 'fake-yt-dlp.mjs');
  await writeFile(
    executablePath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const url = args.at(-1);
if (url === 'https://www.youtube.com/watch?v=${FIRST_VIDEO_ID}' || url === 'https://youtu.be/${FIRST_VIDEO_ID}') {
  process.stdout.write(JSON.stringify({
    extractor_key: 'Youtube',
    id: '${FIRST_VIDEO_ID}',
    title: 'Direct title',
    upload_date: '20260716',
    webpage_url: url,
    live_status: 'not_live'
  }) + '\\n');
  process.exit(0);
}
if (url === 'https://www.youtube.com/watch?v=${SECOND_VIDEO_ID}' || url === 'https://youtu.be/${SECOND_VIDEO_ID}') {
  process.stdout.write(JSON.stringify({
    extractor_key: 'Youtube',
    id: '${SECOND_VIDEO_ID}',
    title: '',
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
    title: 'Generic title',
    duration: 125.2
  }) + '\\n');
  process.exit(0);
}
process.stderr.write('probe failed for http://alice:secret@proxy.example:8080');
process.exit(3);
`,
    'utf8',
  );
  await chmod(executablePath, 0o755);
}

function insertProxy(name = 'office'): number {
  const result = database
    .prepare(
      `INSERT INTO proxies (name, proxy_url, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(name, PROXY_URL, NOW.toISOString(), NOW.toISOString());
  return Number(result.lastInsertRowid);
}

function insertChannel(proxyId: number | null): number {
  const result = database
    .prepare(
      `INSERT INTO channels (
        platform, platform_channel_id, source_url, custom_name,
        custom_name_key, proxy_id, check_interval_minutes,
        initial_synced_at, created_at, updated_at
      ) VALUES ('youtube', 'UC-downloads', 'https://www.youtube.com/@downloads',
                'Saved channel', 'saved channel', ?, NULL, ?, ?, ?)`,
    )
    .run(proxyId, NOW.toISOString(), NOW.toISOString(), NOW.toISOString());
  return Number(result.lastInsertRowid);
}

function insertVideo(
  channelId: number,
  platformVideoId: string,
  title: string,
  publishedDate: string,
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
      `https://www.youtube.com/watch?v=${platformVideoId}`,
      NOW.toISOString(),
    );
  return Number(result.lastInsertRowid);
}

function downloadRows(): unknown[] {
  return database.prepare('SELECT * FROM downloads ORDER BY id').all();
}

function expectSingleConcurrentSuccess(
  results: readonly PromiseSettledResult<unknown>[],
): void {
  expect(
    results.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  expect(rejected).toHaveLength(1);
  expect(rejected[0]?.reason).toMatchObject({ code: 'DOWNLOAD_ALREADY_EXISTS' });
}

async function expectBusinessError(
  operation: Promise<unknown>,
  code: BusinessError['code'],
): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code });
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'vidharbor-download-service-'));
  downloadRoot = join(sandbox, 'downloads');
  await mkdir(downloadRoot);
  await installFakeYtDlp();
  database = openDatabase(join(sandbox, 'vidharbor.sqlite'));
  migrateDatabase(database);
  queued = [];
  queue = {
    enqueue: (download) => queued.push(download),
    cancel: async () => undefined,
  };
  taskManager = new YtDlpTaskManager(executablePath, 1, (message) => message);
});

afterEach(async () => {
  try {
    database.close();
  } catch {
    // A persistence-boundary test may already have closed the connection.
  }
  await rm(sandbox, { recursive: true, force: true });
});

describe('download creation service', () => {
  it('creates a Bilibili channel download with the persisted platform', async () => {
    const channelResult = database.prepare(
      `INSERT INTO channels (
        platform, extractor, platform_channel_id, source_url, custom_name,
        custom_name_key, proxy_id, check_interval_minutes,
        initial_synced_at, created_at, updated_at
      ) VALUES ('bilibili', 'BilibiliSpaceVideo', '3985676',
        'https://space.bilibili.com/3985676', 'Bilibili UP', 'bilibili up',
        NULL, NULL, ?, ?, ?)`,
    ).run(NOW.toISOString(), NOW.toISOString(), NOW.toISOString());
    const channelId = Number(channelResult.lastInsertRowid);
    const videoResult = database.prepare(
      `INSERT INTO videos (
        channel_id, platform, platform_video_id, title, published_date,
        source_url, discovery_kind, discovered_at
      ) VALUES (?, 'bilibili', 'BV13x41117TL', 'Bilibili video', '2026-07-18',
        'https://www.bilibili.com/video/BV13x41117TL', 'historical', ?)`,
    ).run(channelId, NOW.toISOString());

    await expect(createChannelDownloads(
      database,
      downloadRoot,
      [Number(videoResult.lastInsertRowid)],
      queue,
      NOW,
    )).resolves.toEqual([
      expect.objectContaining({ title: 'Bilibili video', sourceType: 'channel' }),
    ]);
    expect(queued).toEqual([
      expect.objectContaining({
        sourceUrl: 'https://www.bilibili.com/video/BV13x41117TL',
        platformVideoId: 'BV13x41117TL',
      }),
    ]);
    expect(downloadRows()).toEqual([
      expect.objectContaining({ platform: 'bilibili', platform_video_id: 'BV13x41117TL' }),
    ]);
  });

  it('creates a channel batch atomically and enqueues proxy-bearing jobs in request order', async () => {
    const proxyId = insertProxy();
    const channelId = insertChannel(proxyId);
    const firstId = insertVideo(channelId, FIRST_VIDEO_ID, 'First title', '2025-12-31');
    const secondId = insertVideo(channelId, SECOND_VIDEO_ID, 'Second title', '2026-01-01');

    await expect(
      createChannelDownloads(
        database,
        downloadRoot,
        [secondId, firstId],
        queue,
        NOW,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        id: expect.any(Number),
        sourceType: 'channel',
        title: 'Second title',
        status: 'pending',
        networkMode: 'proxy',
        proxyName: 'office',
      }),
      expect.objectContaining({
        id: expect.any(Number),
        sourceType: 'channel',
        title: 'First title',
        status: 'pending',
        networkMode: 'proxy',
        proxyName: 'office',
      }),
    ]);

    expect(queued.map((job) => job.platformVideoId)).toEqual([
      SECOND_VIDEO_ID,
      FIRST_VIDEO_ID,
    ]);
    expect(queued.map((job) => job.proxyUrl)).toEqual([PROXY_URL, PROXY_URL]);
    const realDownloadRoot = await realpath(downloadRoot);
    expect(queued.map((job) => job.downloadRoot)).toEqual([
      realDownloadRoot,
      realDownloadRoot,
    ]);
    expect(downloadRows()).toEqual([
      expect.objectContaining({
        platform_video_id: SECOND_VIDEO_ID,
        proxy_name: 'office',
        network_mode: 'proxy',
        status: 'pending',
      }),
      expect.objectContaining({
        platform_video_id: FIRST_VIDEO_ID,
        proxy_name: 'office',
        network_mode: 'proxy',
        status: 'pending',
      }),
    ]);
    expect(downloadRows().map((row) => row.proxy_url_snapshot)).toEqual([
      PROXY_URL,
      PROXY_URL,
    ]);
  });

  it('allows channel downloads to override the channel proxy and snapshots the selected proxy', async () => {
    const channelProxyId = insertProxy('channel-proxy');
    const overrideProxyId = insertProxy('override-proxy');
    const channelId = insertChannel(channelProxyId);
    const videoId = insertVideo(channelId, FIRST_VIDEO_ID, 'First title', '2026-07-16');

    const [download] = await createChannelDownloads(
      database,
      downloadRoot,
      [videoId],
      queue,
      NOW,
      overrideProxyId,
    );

    database
      .prepare('UPDATE proxies SET name = ?, proxy_url = ? WHERE id = ?')
      .run('changed-proxy', 'http://changed.example:8080', overrideProxyId);
    database
      .prepare('UPDATE channels SET proxy_id = NULL WHERE id = ?')
      .run(channelId);

    expect(download).toMatchObject({
      networkMode: 'proxy',
      proxyName: 'override-proxy',
    });
    expect(downloadRows()).toEqual([
      expect.objectContaining({
        network_mode: 'proxy',
        proxy_name: 'override-proxy',
      }),
    ]);
    expect(queued).toEqual([
      expect.objectContaining({
        proxyUrl: PROXY_URL,
      }),
    ]);
  });

  it('allows channel downloads to override the channel proxy with direct', async () => {
    const proxyId = insertProxy('channel-proxy');
    const channelId = insertChannel(proxyId);
    const videoId = insertVideo(channelId, FIRST_VIDEO_ID, 'First title', '2026-07-16');

    const [download] = await createChannelDownloads(
      database,
      downloadRoot,
      [videoId],
      queue,
      NOW,
      null,
    );

    expect(download).toMatchObject({
      networkMode: 'direct',
      proxyName: null,
    });
    expect(queued).toEqual([
      expect.not.objectContaining({
        proxyUrl: expect.any(String),
      }),
    ]);
  });

  it('rejects duplicate or partially unknown channel video IDs without writes or queue notifications', async () => {
    const channelId = insertChannel(null);
    const videoId = insertVideo(channelId, FIRST_VIDEO_ID, 'First title', '2026-07-16');

    await expectBusinessError(
      createChannelDownloads(database, downloadRoot, [videoId, videoId], queue, NOW),
      'VALIDATION_ERROR',
    );
    await expectBusinessError(
      createChannelDownloads(database, downloadRoot, [videoId, 999], queue, NOW),
      'VIDEO_NOT_FOUND',
    );

    expect(downloadRows()).toEqual([]);
    expect(queued).toEqual([]);
  });

  it('rolls back every channel record when persistence fails during a batch', async () => {
    const channelId = insertChannel(null);
    const firstId = insertVideo(channelId, FIRST_VIDEO_ID, 'First title', '2026-07-16');
    const secondId = insertVideo(channelId, SECOND_VIDEO_ID, 'Second title', '2026-07-16');
    database.exec(`
      CREATE TRIGGER fail_second_download BEFORE INSERT ON downloads
      WHEN NEW.platform_video_id = '${SECOND_VIDEO_ID}'
      BEGIN SELECT RAISE(ABORT, 'forced failure'); END
    `);

    await expectBusinessError(
      createChannelDownloads(database, downloadRoot, [firstId, secondId], queue, NOW),
      'PERSISTENCE_ERROR',
    );

    expect(downloadRows()).toEqual([]);
    expect(queued).toEqual([]);
  });

  it('probes a generic HTTPS video, persists its extractor, and snapshots the selected proxy', async () => {
    const proxyId = insertProxy();

    const result = await createDirectDownload(
      database,
      taskManager,
      downloadRoot,
      directInput(GENERIC_VIDEO_URL, proxyId),
      queue,
      NOW,
    );

    expect(result).toMatchObject({
      sourceType: 'direct',
      title: 'Generic title',
      status: 'pending',
      networkMode: 'proxy',
      proxyName: 'office',
    });
    expect(database.prepare('SELECT COUNT(*) FROM channels').pluck().get()).toBe(0);
    expect(downloadRows()).toEqual([
      expect.objectContaining({
        source_type: 'direct',
        channel_id: null,
        video_id: null,
        source_url: GENERIC_VIDEO_URL,
        platform: 'generic',
        platform_video_id: GENERIC_VIDEO_ID,
        title: 'Generic title',
        published_date: null,
        duration_seconds: 126,
        proxy_name: 'office',
      }),
    ]);
    const realDownloadRoot = await realpath(downloadRoot);
    expect(queued).toEqual([
      expect.objectContaining({
        downloadId: result.id,
        sourceUrl: GENERIC_VIDEO_URL,
        platformVideoId: GENERIC_VIDEO_ID,
        proxyUrl: PROXY_URL,
        downloadRoot: realDownloadRoot,
      }),
    ]);
    expect(taskManager.getSnapshot()).toEqual([
      expect.objectContaining({
        type: 'metadata_probe',
        status: 'succeeded',
      }),
    ]);

    database
      .prepare(
        `UPDATE downloads
         SET status = 'failed', failure_reason = 'network error',
             progress_percent = 42.5, speed_text = '1.2MiB/s', eta_seconds = 17,
             exit_code = 3, finished_at = ?
         WHERE id = ?`,
      )
      .run(NOW.toISOString(), result.id);
    queued = [];
    queue = {
      enqueue: (download) => queued.push(download),
      cancel: async () => undefined,
    };

    await retryDownload(database, downloadRoot, result.id, queue, NOW);

    expect(queued[0]?.sourceUrl).toBe(GENERIC_VIDEO_URL);
    expect(database
      .prepare(
        `SELECT status, progress_percent, speed_text, eta_seconds, exit_code
         FROM downloads WHERE id = ?`,
      )
      .get(result.id)).toEqual({
      status: 'pending',
      progress_percent: null,
      speed_text: null,
      eta_seconds: null,
      exit_code: null,
    });
  });

  it('returns only a verified completed main file', async () => {
    const result = await createDirectDownload(
      database,
      taskManager,
      downloadRoot,
      directInput(`https://youtu.be/${FIRST_VIDEO_ID}`, null),
      queue,
      NOW,
    );
    await expectBusinessError(
      getDownloadFile(database, downloadRoot, result.id),
      'DOWNLOAD_FILE_UNAVAILABLE',
    );
    await expectBusinessError(
      getDownloadFile(database, downloadRoot, 999),
      'DOWNLOAD_NOT_FOUND',
    );

    const filePath = join(downloadRoot, 'finished.webm');
    await writeFile(filePath, 'media');
    database
      .prepare(
        `UPDATE downloads
         SET status = 'completed', output_path = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(filePath, NOW.toISOString(), result.id);

    const file = await getDownloadFile(database, downloadRoot, result.id);
    expect(file).toMatchObject({
      path: await realpath(filePath),
      filename: 'finished.webm',
      size: 5,
    });

    const originalPath = join(downloadRoot, 'original.webm');
    const outsidePath = join(sandbox, 'outside.webm');
    await rename(filePath, originalPath);
    await writeFile(outsidePath, 'secret');
    await symlink(outsidePath, filePath);
    await expect(file.handle.readFile({ encoding: 'utf8' })).resolves.toBe('media');
    await file.handle.close();
  });

  it('maps completed-file persistence failures', async () => {
    database.close();

    await expectBusinessError(
      getDownloadFile(database, downloadRoot, 1),
      'PERSISTENCE_ERROR',
    );
  });

  it('rejects unknown proxies and invalid direct metadata without creating records', async () => {
    await expectBusinessError(
      createDirectDownload(
        database,
        taskManager,
        downloadRoot,
        directInput(`https://youtu.be/${FIRST_VIDEO_ID}`, 999),
        queue,
        NOW,
      ),
      'PROXY_NOT_FOUND',
    );
    await expectBusinessError(
      createDirectDownload(
        database,
        taskManager,
        downloadRoot,
        directInput(`https://youtu.be/${SECOND_VIDEO_ID}`, null),
        queue,
        NOW,
      ),
      'VIDEO_METADATA_INVALID',
    );

    expect(downloadRows()).toEqual([]);
    expect(queued).toEqual([]);
  });

  it('maps metadata probe failures without creating a download record', async () => {
    await expectBusinessError(
      createDirectDownload(
        database,
        taskManager,
        downloadRoot,
        directInput('https://example.com/probe-failure', null),
        queue,
        NOW,
      ),
      'VIDEO_FETCH_FAILED',
    );

    expect(downloadRows()).toEqual([]);
    expect(queued).toEqual([]);
    expect(taskManager.getSnapshot()).toEqual([
      expect.objectContaining({
        type: 'metadata_probe',
        status: 'failed',
      }),
    ]);
  });

  it('waits for queue cancellation after marking an active download canceled', async () => {
    const channelId = insertChannel(null);
    const videoId = insertVideo(
      channelId,
      FIRST_VIDEO_ID,
      'First title',
      '2026-07-16',
    );
    const [download] = await createChannelDownloads(
      database,
      downloadRoot,
      [videoId],
      queue,
      NOW,
    );
    if (download === undefined) throw new Error('expected a download');

    let resolveCancellation!: () => void;
    const queueCancellation = new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    });
    let canceledDownloadId: number | undefined;
    queue = {
      enqueue: (queuedDownload) => queued.push(queuedDownload),
      cancel: (downloadId) => {
        canceledDownloadId = downloadId;
        return queueCancellation;
      },
    };

    let settled = false;
    const cancellation = cancelDownload(database, download.id, queue, NOW).then(
      () => {
        settled = true;
      },
    );
    await Promise.resolve();

    expect(canceledDownloadId).toBe(download.id);
    expect(database
      .prepare('SELECT status FROM downloads WHERE id = ?')
      .pluck()
      .get(download.id)).toBe('canceled');
    expect(settled).toBe(false);

    resolveCancellation();
    await cancellation;
    expect(settled).toBe(true);
  });

  it('rejects non-HTTPS URLs before probing or creating records', async () => {
    await expectBusinessError(
      createDirectDownload(
        database,
        taskManager,
        downloadRoot,
        directInput('http://media.example/videos/generic-123456789', null),
        queue,
        NOW,
      ),
      'NOT_A_VIDEO_URL',
    );

    expect(downloadRows()).toEqual([]);
    expect(queued).toEqual([]);
  });

  it('uses the downloads mount path as the download root', async () => {
    const channelId = insertChannel(null);
    const videoId = insertVideo(channelId, FIRST_VIDEO_ID, 'First title', '2026-07-16');

    await createChannelDownloads(database, downloadRoot, [videoId], queue, NOW);

    expect(queued).toHaveLength(1);
    expect(queued[0]?.downloadRoot).toBe(await realpath(downloadRoot));
  });

  it('blocks active, completed, and target-file duplicates but permits explicit recreation after failure', async () => {
    const channelId = insertChannel(null);
    const videoId = insertVideo(channelId, FIRST_VIDEO_ID, 'First title', '2026-07-16');

    const [first] = await createChannelDownloads(
      database,
      downloadRoot,
      [videoId],
      queue,
      NOW,
    );
    await expectBusinessError(
      createChannelDownloads(database, downloadRoot, [videoId], queue, NOW),
      'DOWNLOAD_ALREADY_EXISTS',
    );

    database
      .prepare("UPDATE downloads SET status = 'downloading', started_at = ? WHERE id = ?")
      .run(NOW.toISOString(), first?.id);
    await expectBusinessError(
      createChannelDownloads(database, downloadRoot, [videoId], queue, NOW),
      'DOWNLOAD_ALREADY_EXISTS',
    );

    database
      .prepare("UPDATE downloads SET status = 'running' WHERE id = ?")
      .run(first?.id);
    await expectBusinessError(
      createChannelDownloads(database, downloadRoot, [videoId], queue, NOW),
      'DOWNLOAD_ALREADY_EXISTS',
    );

    database
      .prepare(
        `UPDATE downloads
         SET status = 'failed', failure_reason = 'explicit failure', finished_at = ?
         WHERE id = ?`,
      )
      .run(NOW.toISOString(), first?.id);
    await expect(
      createChannelDownloads(database, downloadRoot, [videoId], queue, NOW),
    ).resolves.toHaveLength(1);

    database
      .prepare(
        `UPDATE downloads
         SET status = 'completed', output_path = ?, failure_reason = NULL,
             finished_at = ?
         WHERE id = (SELECT MAX(id) FROM downloads)`,
      )
      .run(join(downloadRoot, `${FIRST_VIDEO_ID}.mp4`), NOW.toISOString());
    await expectBusinessError(
      createChannelDownloads(database, downloadRoot, [videoId], queue, NOW),
      'DOWNLOAD_ALREADY_EXISTS',
    );

    database.prepare('DELETE FROM downloads').run();
    await expect(createChannelDownloads(database, downloadRoot, [videoId], queue, NOW))
      .resolves.toHaveLength(1);
  });

  it('atomically rejects one of two concurrent channel requests for the same video', async () => {
    const channelId = insertChannel(null);
    const videoId = insertVideo(
      channelId,
      FIRST_VIDEO_ID,
      'First title',
      '2026-07-16',
    );
    const secondDatabase = openDatabase(join(sandbox, 'vidharbor.sqlite'));

    try {
      const results = await Promise.allSettled([
        createChannelDownloads(database, downloadRoot, [videoId], queue, NOW),
        createChannelDownloads(
          secondDatabase,
          downloadRoot,
          [videoId],
          queue,
          NOW,
        ),
      ]);

      expectSingleConcurrentSuccess(results);
      expect(downloadRows()).toHaveLength(1);
      expect(queued).toHaveLength(1);
    } finally {
      secondDatabase.close();
    }
  });

  it('atomically rejects one of two concurrent direct requests for the same video', async () => {
    const secondDatabase = openDatabase(join(sandbox, 'vidharbor.sqlite'));
    const input = directInput(`https://youtu.be/${FIRST_VIDEO_ID}`, null);

    try {
      const results = await Promise.allSettled([
        createDirectDownload(
          database,
          taskManager,
          downloadRoot,
          input,
          queue,
          NOW,
        ),
        createDirectDownload(
          secondDatabase,
          taskManager,
          downloadRoot,
          input,
          queue,
          NOW,
        ),
      ]);

      expectSingleConcurrentSuccess(results);
      expect(downloadRows()).toHaveLength(1);
      expect(queued).toHaveLength(1);
    } finally {
      secondDatabase.close();
    }
  });

  it('rejects a direct duplicate while the existing task is running', async () => {
    const input = directInput(`https://youtu.be/${FIRST_VIDEO_ID}`, null);
    const first = await createDirectDownload(
      database,
      taskManager,
      downloadRoot,
      input,
      queue,
      NOW,
    );
    database
      .prepare("UPDATE downloads SET status = 'running', started_at = ? WHERE id = ?")
      .run(NOW.toISOString(), first.id);

    await expectBusinessError(
      createDirectDownload(
        database,
        taskManager,
        downloadRoot,
        input,
        queue,
        NOW,
      ),
      'DOWNLOAD_ALREADY_EXISTS',
    );

    expect(downloadRows()).toHaveLength(1);
    expect(queued).toHaveLength(1);
  });

});
