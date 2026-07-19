import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupInterruptedDownloadDirectories,
  listInterruptedDownloadIds,
  recoverInterruptedDownloads,
} from '../../src/download-worker.js';
import { openDatabase, type DatabaseConnection } from '../../src/db/client.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { recoverInterruptedChannelSyncs } from '../../src/services/channel.js';

const FINISHED_AT = '2026-07-17T12:00:00.000Z';

let sandbox: string;
let downloadRoot: string;
let database: DatabaseConnection;

function insertDownload(
  status: 'pending' | 'downloading' | 'running' | 'completed' | 'failed' | 'interrupted',
): number {
  const outputPath = status === 'completed' ? join(downloadRoot, 'finished.mp4') : null;
  const failureReason = status === 'failed' ? 'previous failure' : null;
  const finishedAt = status === 'completed' || status === 'failed'
    ? '2026-07-17T11:30:00.000Z'
    : null;
  const result = database
    .prepare(
      `INSERT INTO downloads (
        source_type, source_url, platform, platform_video_id, title,
        network_mode, status, output_path, failure_reason, created_at, finished_at
      ) VALUES ('direct', ?, 'youtube', ?, 'Title', 'direct', ?, ?, ?, ?, ?)`,
    )
    .run(
      `https://www.youtube.com/watch?v=${status}`,
      `${status}-id`,
      status,
      outputPath,
      failureReason,
      '2026-07-17T11:20:00.000Z',
      finishedAt,
    );
  return Number(result.lastInsertRowid);
}

function downloadRow(id: number): Record<string, unknown> {
  return database.prepare('SELECT * FROM downloads WHERE id = ?').get(id) as Record<
    string,
    unknown
  >;
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'vidharbor-restart-recovery-'));
  downloadRoot = join(sandbox, 'downloads');
  await mkdir(downloadRoot);
  database = openDatabase(join(sandbox, 'vidharbor.sqlite'));
  migrateDatabase(database);
});

afterEach(async () => {
  try {
    database.close();
  } catch {
    // A test may intentionally close the database.
  }
  await rm(sandbox, { recursive: true, force: true });
});

describe('restart recovery', () => {
  it('marks an interrupted initial channel sync as failed and retryable', () => {
    const channelId = Number(database
      .prepare(
        `INSERT INTO channels (
          platform, platform_channel_id, source_url, custom_name,
          custom_name_key, initial_sync_status, created_at, updated_at
        ) VALUES ('youtube', NULL, ?, 'Pending', 'pending', 'syncing', ?, ?)`,
      )
      .run('https://www.youtube.com/@pending', FINISHED_AT, FINISHED_AT)
      .lastInsertRowid);
    database
      .prepare(
        `INSERT INTO channel_checks (kind, channel_id, requested_url, started_at)
         VALUES ('initial', ?, ?, ?)`,
      )
      .run(channelId, 'https://www.youtube.com/@pending', FINISHED_AT);

    recoverInterruptedChannelSyncs(database, FINISHED_AT);

    expect(
      database
        .prepare('SELECT initial_sync_status, initial_sync_error FROM channels WHERE id = ?')
        .get(channelId),
    ).toEqual({
      initial_sync_status: 'failed',
      initial_sync_error: 'initial synchronization interrupted by restart',
    });
    expect(
      database.prepare('SELECT result, failure_reason FROM channel_checks WHERE channel_id = ?').get(channelId),
    ).toEqual({
      result: 'failed',
      failure_reason: 'initial synchronization interrupted by restart',
    });
  });

  it('interrupts pending and active records in one recovery while preserving terminal records', () => {
    const pendingId = insertDownload('pending');
    const downloadingId = insertDownload('downloading');
    const completedId = insertDownload('completed');
    const failedId = insertDownload('failed');

    const interruptedIds = listInterruptedDownloadIds(database);
    recoverInterruptedDownloads(database, interruptedIds, FINISHED_AT);

    expect(interruptedIds).toEqual([pendingId, downloadingId]);
    for (const id of interruptedIds) {
      expect(downloadRow(id)).toMatchObject({
        status: 'interrupted',
        output_path: null,
        failure_reason: 'service restarted before task completed',
        finished_at: FINISHED_AT,
      });
    }
    expect(downloadRow(completedId)).toMatchObject({
      status: 'completed',
      output_path: join(downloadRoot, 'finished.mp4'),
      failure_reason: null,
      finished_at: '2026-07-17T11:30:00.000Z',
    });
    expect(downloadRow(failedId)).toMatchObject({
      status: 'failed',
      output_path: null,
      failure_reason: 'previous failure',
      finished_at: '2026-07-17T11:30:00.000Z',
    });
  });

  it('rolls back every state change and throws when persistence fails', () => {
    const pendingId = insertDownload('pending');
    const downloadingId = insertDownload('downloading');
    database.exec(`
      CREATE TRIGGER reject_downloading_recovery
      BEFORE UPDATE ON downloads
      WHEN OLD.status = 'downloading'
      BEGIN
        SELECT RAISE(ABORT, 'recovery persistence failed');
      END;
    `);

    const interruptedIds = listInterruptedDownloadIds(database);
    expect(() => recoverInterruptedDownloads(database, interruptedIds, FINISHED_AT)).toThrow(
      'recovery persistence failed',
    );
    expect(downloadRow(pendingId)).toMatchObject({
      status: 'pending',
      failure_reason: null,
      finished_at: null,
    });
    expect(downloadRow(downloadingId)).toMatchObject({
      status: 'downloading',
      failure_reason: null,
      finished_at: null,
    });
  });

  it('removes only temporary directories belonging to interrupted records', async () => {
    const temporaryRoot = join(downloadRoot, '.vidharbor-tmp');
    const firstId = insertDownload('pending');
    const secondId = insertDownload('downloading');
    const unknownId = 9999;
    await mkdir(join(temporaryRoot, String(firstId)), { recursive: true });
    await mkdir(join(temporaryRoot, String(secondId)), { recursive: true });
    await mkdir(join(temporaryRoot, String(unknownId)), { recursive: true });
    await writeFile(join(temporaryRoot, String(firstId), 'partial.mp4'), 'partial');

    const interruptedIds = listInterruptedDownloadIds(database);
    const failures = await cleanupInterruptedDownloadDirectories(
      downloadRoot,
      interruptedIds,
    );

    expect(failures).toEqual([]);
    await expect(readdir(join(temporaryRoot, String(firstId)))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readdir(join(temporaryRoot, String(secondId)))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readdir(join(temporaryRoot, String(unknownId)))).resolves.toEqual([]);
  });

  it('reports a targeted cleanup failure with its interrupted record ID', async () => {
    const interruptedId = insertDownload('pending');
    await writeFile(join(downloadRoot, '.vidharbor-tmp'), 'not a directory');
    const interruptedIds = listInterruptedDownloadIds(database);

    const failures = await cleanupInterruptedDownloadDirectories(
      downloadRoot,
      interruptedIds,
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ downloadId: interruptedId });
    expect(failures[0]?.error).toBeInstanceOf(Error);
    expect(downloadRow(interruptedId)).toMatchObject({
      status: 'pending',
      failure_reason: null,
      finished_at: null,
    });
    await expect(readFile(join(downloadRoot, '.vidharbor-tmp'), 'utf8')).resolves.toBe(
      'not a directory',
    );

    await rm(join(downloadRoot, '.vidharbor-tmp'));
    await mkdir(join(downloadRoot, '.vidharbor-tmp', String(interruptedId)), {
      recursive: true,
    });
    const retryIds = listInterruptedDownloadIds(database);
    expect(retryIds).toEqual([interruptedId]);
    await expect(
      cleanupInterruptedDownloadDirectories(downloadRoot, retryIds),
    ).resolves.toEqual([]);
    recoverInterruptedDownloads(database, retryIds, FINISHED_AT);
    expect(downloadRow(interruptedId)).toMatchObject({
      status: 'interrupted',
      failure_reason: 'service restarted before task completed',
      finished_at: FINISHED_AT,
    });
  });

  it('does not follow a known task symlink to an unknown task directory', async () => {
    const interruptedId = insertDownload('pending');
    const temporaryRoot = join(downloadRoot, '.vidharbor-tmp');
    const unknownDirectory = join(temporaryRoot, '9999');
    await mkdir(unknownDirectory, { recursive: true });
    await writeFile(join(unknownDirectory, 'preserve.txt'), 'preserve');
    await symlink(unknownDirectory, join(temporaryRoot, String(interruptedId)));

    const failures = await cleanupInterruptedDownloadDirectories(
      downloadRoot,
      [interruptedId],
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ downloadId: interruptedId });
    await expect(readFile(join(unknownDirectory, 'preserve.txt'), 'utf8')).resolves.toBe(
      'preserve',
    );
  });
});
