import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, type DatabaseConnection } from '../../src/db/client.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import {
  DownloadWorker,
  listInterruptedDownloadIds,
  recoverInterruptedDownloads,
} from '../../src/download-worker.js';
import {
  checkChannel,
  initialSyncChannel,
  listChannels,
  listChannelVideos,
  saveChannel,
} from '../../src/services/channel.js';
import { createChannelDownloads, type QueuedDownload } from '../../src/services/download.js';
import { listNotifications } from '../../src/services/notification.js';
import { updateSettings } from '../../src/services/settings.js';
import { fetchChannelEntries } from '../../src/yt-dlp.js';
import { YtDlpTaskManager } from '../../src/yt-dlp-task-manager.js';

const STARTED_AT = new Date('2026-07-17T08:30:00.000Z');
const HISTORICAL_VIDEO_ID = 'hI_12-aB345';
const FAILED_VIDEO_ID = 'fF_12-cD345';
const NEW_VIDEO_ID = 'nE_12-eF345';
const CHANNEL_URL = 'https://www.youtube.com/@harbor';
const FAKE_FFMPEG_PATH = fileURLToPath(
  new URL('../fixtures/fake-ffmpeg.mjs', import.meta.url),
);
const PROCESS_FIXTURE_PATH = fileURLToPath(
  new URL('../fixtures/fake-yt-dlp.mjs', import.meta.url),
);

let sandbox: string;
let downloadRoot: string;
let statePath: string;
let ytDlpPath: string;
let database: DatabaseConnection;
let taskManager: YtDlpTaskManager;

async function createChannel(
  connection: DatabaseConnection,
  manager: YtDlpTaskManager,
  input: unknown,
  startedAt: Date,
) {
  const channel = saveChannel(connection, input, startedAt);
  return initialSyncChannel(
    connection,
    manager,
    channel.id,
    { historyMonths: 12 },
    startedAt,
  );
}

function metadata(
  id: string,
  title: string,
  liveStatus = 'not_live',
): Record<string, unknown> {
  return {
    extractor_key: 'Youtube',
    id,
    channel_id: 'UC-harbor',
    title,
    upload_date: '20260717',
    webpage_url: `https://www.youtube.com/watch?v=${id}`,
    live_status: liveStatus,
  };
}

async function installFakeYtDlp(): Promise<void> {
  ytDlpPath = join(sandbox, 'fake-yt-dlp.mjs');
  const initial = [
    metadata(HISTORICAL_VIDEO_ID, 'Historical video'),
    metadata(FAILED_VIDEO_ID, 'FFmpeg failure video'),
  ];
  const updated = [...initial, metadata(NEW_VIDEO_ID, 'New video')];
  await writeFile(
    ytDlpPath,
    `#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const url = args.at(-1);
const emit = (values) => values.forEach((value) => process.stdout.write(JSON.stringify(value) + '\\n'));

if (args.includes('--dump-json')) {
  if (url === '${CHANNEL_URL}/videos') emit(existsSync(${JSON.stringify(statePath)}) ? ${JSON.stringify(updated)} : ${JSON.stringify(initial)});
  else if (url === 'https://www.youtube.com/@malformed/videos') process.stdout.write('{bad json}\\n');
  else if (url === 'https://www.youtube.com/@invalid/videos') emit([${JSON.stringify(metadata(HISTORICAL_VIDEO_ID, '', 'not_live'))}]);
  else if (url === 'https://www.youtube.com/@unknown/videos') emit([${JSON.stringify(metadata(HISTORICAL_VIDEO_ID, 'Unknown live', 'mystery'))}]);
  else if (url === 'https://www.youtube.com/@empty/videos') process.exit(0);
  else process.exit(2);
  process.exit(0);
}

const outputTemplate = args[args.indexOf('--output') + 1];
const id = new URL(url).searchParams.get('v');
const filepath = outputTemplate.replace('%(id)s', id).replace('%(ext)s', 'mp4');
if (url.includes('outside')) {
  const outside = join(${JSON.stringify(sandbox)}, 'outside.mp4');
  await writeFile(outside, 'outside');
  process.stdout.write(outside + '\\n');
  process.exit(0);
}
await mkdir(dirname(filepath), { recursive: true });
if (url.includes('no-file')) {
  process.stdout.write(filepath + '\\n');
  process.exit(0);
}
if (url.includes('zero')) {
  await writeFile(filepath, '');
  process.stdout.write(filepath + '\\n');
  process.exit(0);
}
const mode = id === '${FAILED_VIDEO_ID}' ? 'failure' : 'success';
const ffmpeg = spawnSync(${JSON.stringify(FAKE_FFMPEG_PATH)}, [mode, filepath], { encoding: 'utf8' });
if (ffmpeg.status !== 0) {
  process.stderr.write(ffmpeg.stderr);
  process.exit(ffmpeg.status ?? 1);
}
process.stdout.write(filepath + '\\n');
`,
    'utf8',
  );
  await chmod(ytDlpPath, 0o755);
}

function insertPending(
  platformVideoId: string,
  status: 'pending' | 'downloading' = 'pending',
): number {
  const result = database
    .prepare(
      `INSERT INTO downloads (
        source_type, source_url, platform, platform_video_id, title,
        network_mode, archive_layout, status, created_at
      ) VALUES ('direct', ?, 'youtube', ?, 'Fixture', 'direct', 'download_directory', ?, ?)`,
    )
    .run(
      `https://www.youtube.com/watch?v=${platformVideoId}`,
      platformVideoId,
      status,
      STARTED_AT.toISOString(),
    );
  return Number(result.lastInsertRowid);
}

function queuedDownload(
  downloadId: number,
  platformVideoId: string,
  sourceUrl: string,
): QueuedDownload {
  return {
    downloadId,
    sourceUrl,
    platformVideoId,
    downloadRoot,
    downloadsMountPath: downloadRoot,
  };
}

function downloadStatus(downloadId: number): string {
  return database
    .prepare('SELECT status FROM downloads WHERE id = ?')
    .pluck()
    .get(downloadId) as string;
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'vidharbor-end-to-end-'));
  downloadRoot = join(sandbox, 'downloads');
  statePath = join(sandbox, 'updated');
  await mkdir(downloadRoot);
  await chmod(FAKE_FFMPEG_PATH, 0o755);
  await chmod(PROCESS_FIXTURE_PATH, 0o755);
  await installFakeYtDlp();
  database = openDatabase(join(sandbox, 'vidharbor.sqlite'));
  migrateDatabase(database);
  taskManager = new YtDlpTaskManager(ytDlpPath, 1, (message) => message);
});

afterEach(async () => {
  await taskManager.stop();
  try {
    database.close();
  } catch {
    // A restart assertion may already have closed this connection.
  }
  await rm(sandbox, { recursive: true, force: true });
});

describe('offline v0.1 end-to-end contract', () => {
  it('persists configuration, syncs without historical alerts, alerts on updates, archives a selected video, isolates failure, and survives restart', async () => {
    await updateSettings(database, downloadRoot, {
      downloadRoot,
      globalCheckIntervalMinutes: 60,
      downloadConcurrency: 1,
    });
    const created = await createChannel(
      database,
      taskManager,
      {
        url: CHANNEL_URL,
        customName: 'Harbor Channel',
        proxyId: null,
        checkIntervalMinutes: null,
      },
      STARTED_AT,
    );
    expect(created.historicalVideoCount).toBe(2);
    expect(listNotifications(database)).toEqual([]);

    await writeFile(statePath, 'updated');
    await expect(
      checkChannel(database, taskManager, created.channel.id, STARTED_AT),
    ).resolves.toEqual({ newVideoCount: 1 });
    expect(taskManager.getSnapshot().map((task) => task.type)).toEqual([
      'channel_initial_sync',
      'channel_manual_check',
    ]);
    const notification = listNotifications(database)[0];
    expect(notification?.video.title).toBe('New video');

    const videos = listChannelVideos(database, created.channel.id);
    const selectedIds = videos
      .filter((video) => ['New video', 'FFmpeg failure video'].includes(video.title))
      .map((video) => video.id);
    const worker = new DownloadWorker(database, taskManager);
    const downloads = await createChannelDownloads(
      database,
      downloadRoot,
      selectedIds,
      worker,
      STARTED_AT,
    );
    await worker.waitForIdle();

    const rows = database
      .prepare('SELECT title, status, output_path FROM downloads ORDER BY id')
      .all() as Array<{ title: string; status: string; output_path: string | null }>;
    expect(rows).toEqual([
      { title: 'New video', status: 'completed', output_path: expect.any(String) },
      { title: 'FFmpeg failure video', status: 'failed', output_path: null },
    ]);
    expect(downloads).toHaveLength(2);
    await expect(
      readFile(join(downloadRoot, String(downloads[0]?.id), `${NEW_VIDEO_ID}.mp4`), 'utf8'),
    ).resolves.toBe('fake media');

    database.close();
    database = openDatabase(join(sandbox, 'vidharbor.sqlite'));
    expect(listChannels(database)).toHaveLength(1);
    expect(listChannelVideos(database, created.channel.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'New video',
          downloadId: downloads[0]?.id,
          downloadStatus: 'completed',
          downloadFinishedAt: expect.any(String),
          downloadOutputSizeBytes: Buffer.byteLength('fake media'),
          downloadFailureReason: null,
        }),
        expect.objectContaining({
          title: 'FFmpeg failure video',
          downloadId: downloads[1]?.id,
          downloadStatus: 'failed',
          downloadFinishedAt: expect.any(String),
          downloadOutputSizeBytes: null,
          downloadFailureReason: expect.any(String),
        }),
      ]),
    );
    expect(listNotifications(database)).toHaveLength(1);
  });

  it('fails closed for malformed or unsupported channel results', async () => {
    database
      .prepare('UPDATE settings SET global_check_interval_minutes = 60')
      .run();
    for (const [handle, code] of [
      ['malformed', 'CHANNEL_FETCH_FAILED'],
      ['invalid', 'CHANNEL_METADATA_INVALID'],
      ['unknown', 'CHANNEL_METADATA_INVALID'],
    ] as const) {
      await expect(
        createChannel(
          database,
          taskManager,
          {
            url: `https://www.youtube.com/@${handle}`,
            customName: `Rejected ${handle}`,
            proxyId: null,
            checkIntervalMinutes: null,
          },
          STARTED_AT,
        ),
      ).rejects.toMatchObject({ code });
    }
    expect(database.prepare('SELECT COUNT(*) FROM channels').pluck().get()).toBe(3);
    expect(
      database.prepare("SELECT COUNT(*) FROM channels WHERE initial_sync_status = 'failed'").pluck().get(),
    ).toBe(3);
    expect(database.prepare('SELECT COUNT(*) FROM videos').pluck().get()).toBe(0);
  });

  it('covers process and file failures without retry or cross-task contamination', async () => {
    await expect(
      fetchChannelEntries({ executablePath: PROCESS_FIXTURE_PATH, url: 'fixture://nonzero' }),
    ).rejects.toThrow('exit code 3');
    await expect(
      fetchChannelEntries({ executablePath: PROCESS_FIXTURE_PATH, url: 'fixture://signal' }),
    ).rejects.toThrow('signal SIGTERM');
    await expect(
      fetchChannelEntries({ executablePath: PROCESS_FIXTURE_PATH, url: 'fixture://malformed' }),
    ).rejects.toThrow('malformed JSON');

    vi.useFakeTimers();
    try {
      const timedOut = fetchChannelEntries({
        executablePath: PROCESS_FIXTURE_PATH,
        url: 'fixture://hang',
      });
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      await expect(timedOut).rejects.toThrow('timed out after 900000 ms');
    } finally {
      vi.useRealTimers();
    }

    const worker = new DownloadWorker(database, taskManager);
    const cases = [
      ['no-file', 'no-file'],
      ['zero-byte', 'zero'],
      ['path-outside', 'outside'],
    ] as const;
    for (const [id, mode] of cases) {
      const downloadId = insertPending(id.padEnd(11, 'x'));
      worker.enqueue(
        queuedDownload(downloadId, id.padEnd(11, 'x'), `https://fixture.invalid/${mode}?v=${id.padEnd(11, 'x')}`),
      );
    }
    const existingId = 'eX_12-iS345';
    const existingDownloadId = insertPending(existingId);
    await mkdir(join(downloadRoot, String(existingDownloadId)));
    await writeFile(
      join(downloadRoot, String(existingDownloadId), `${existingId}.mp4`),
      'existing',
    );
    worker.enqueue(
      queuedDownload(
        existingDownloadId,
        existingId,
        `https://www.youtube.com/watch?v=${existingId}`,
      ),
    );
    const successfulId = 'sU_12-cC345';
    const successfulDownloadId = insertPending(successfulId);
    worker.enqueue(
      queuedDownload(
        successfulDownloadId,
        successfulId,
        `https://www.youtube.com/watch?v=${successfulId}`,
      ),
    );
    await worker.waitForIdle();

    for (const row of database.prepare('SELECT id FROM downloads WHERE id <> ?').all(successfulDownloadId) as Array<{ id: number }>) {
      expect(downloadStatus(row.id)).toBe('failed');
    }
    expect(downloadStatus(successfulDownloadId)).toBe('completed');

    const interruptedPendingId = insertPending('pE_12-dI345');
    const interruptedRunningId = insertPending('rU_12-nI345', 'downloading');
    const interruptedIds = listInterruptedDownloadIds(database);
    expect(interruptedIds).toEqual([
      interruptedPendingId,
      interruptedRunningId,
    ]);
    recoverInterruptedDownloads(database, interruptedIds, STARTED_AT.toISOString());
    expect(downloadStatus(interruptedPendingId)).toBe('interrupted');
    expect(downloadStatus(interruptedRunningId)).toBe('interrupted');
  });
});
