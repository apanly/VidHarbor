import { access, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, type DatabaseConnection } from '../../src/db/client.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { BusinessError } from '../../src/errors.js';

const failDeleteRm = vi.hoisted(() => ({
  enabled: false,
  /** When set, unlink this basename inside the quarantine path before failing rm. */
  removeMainBeforeFail: null as string | null,
}));

const realpathFault = vi.hoisted(() => ({
  code: null as null | 'EACCES' | 'EIO',
  match: null as string | null,
}));

const finalizeHold = vi.hoisted(() => {
  let release: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  return {
    arm(): void {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    async waitIfArmed(): Promise<void> {
      if (gate !== undefined) await gate;
    },
    release(): void {
      release?.();
      release = undefined;
      gate = undefined;
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: async (
      path: Parameters<typeof actual.realpath>[0],
      options?: Parameters<typeof actual.realpath>[1],
    ) => {
      if (
        realpathFault.code !== null &&
        realpathFault.match !== null &&
        String(path).includes(realpathFault.match)
      ) {
        throw Object.assign(new Error(`forced realpath ${realpathFault.code}`), {
          code: realpathFault.code,
        });
      }
      return actual.realpath(path as never, options as never);
    },
    rename: async (
      oldPath: Parameters<typeof actual.rename>[0],
      newPath: Parameters<typeof actual.rename>[1],
    ) => {
      if (String(newPath).includes('.vidharbor-delete')) {
        await finalizeHold.waitIfArmed();
      }
      return actual.rename(oldPath, newPath);
    },
    rm: async (
      path: Parameters<typeof actual.rm>[0],
      options?: Parameters<typeof actual.rm>[1],
    ) => {
      // Fail only archive removal, not empty quarantine-parent cleanup.
      if (
        failDeleteRm.enabled &&
        /[/\\]\.vidharbor-delete[/\\]\d+$/.test(String(path))
      ) {
        if (failDeleteRm.removeMainBeforeFail !== null) {
          const mainPath = join(String(path), failDeleteRm.removeMainBeforeFail);
          await actual.rm(mainPath, { force: true });
        }
        throw Object.assign(new Error('forced archive cleanup failure'), {
          code: 'EACCES',
        });
      }
      return actual.rm(path, options);
    },
  };
});

const { deleteDownload, recoverDeletingDownloads } = await import(
  '../../src/services/download.js'
);

const NOW = '2026-07-17T11:20:00.000Z';

let sandbox: string;
let downloadRoot: string;
let database: DatabaseConnection;

async function insertCompletedLegacyDownload(
  filename: string,
  platformVideoId = 'delete-recovery',
): Promise<{
  readonly id: number;
  readonly outputPath: string;
}> {
  const outputPath = join(downloadRoot, filename);
  await writeFile(outputPath, 'archived-media');
  const result = database
    .prepare(
      `INSERT INTO downloads (
        source_type, source_url, platform, platform_video_id, title,
        network_mode, archive_layout, status, output_path, output_size_bytes,
        created_at, finished_at
      ) VALUES (
        'direct', ?, 'generic', ?, 'Delete recovery', 'direct', 'legacy_file',
        'completed', ?, ?, ?, ?
      )`,
    )
    .run(
      `https://media.example/${platformVideoId}`,
      platformVideoId,
      outputPath,
      Buffer.byteLength('archived-media'),
      NOW,
      NOW,
    );
  return { id: Number(result.lastInsertRowid), outputPath };
}

beforeEach(async () => {
  failDeleteRm.enabled = false;
  failDeleteRm.removeMainBeforeFail = null;
  realpathFault.code = null;
  realpathFault.match = null;
  finalizeHold.release();
  sandbox = await mkdtemp(join(tmpdir(), 'vidharbor-delete-recovery-'));
  downloadRoot = join(sandbox, 'downloads');
  await mkdir(downloadRoot);
  database = openDatabase(join(sandbox, 'vidharbor.db'));
  migrateDatabase(database);
});

afterEach(async () => {
  failDeleteRm.enabled = false;
  failDeleteRm.removeMainBeforeFail = null;
  realpathFault.code = null;
  realpathFault.match = null;
  finalizeHold.release();
  database.close();
  const { rm } = await import('node:fs/promises');
  await rm(sandbox, { recursive: true, force: true });
});

describe('two-phase delete with durable deleting status', () => {
  it('keeps status completed and archive when cleanup fails after marking deleting', async () => {
    const { id, outputPath } = await insertCompletedLegacyDownload('recover.webm');
    failDeleteRm.enabled = true;

    await expect(deleteDownload(database, downloadRoot, id)).rejects.toMatchObject({
      code: 'DOWNLOAD_DELETE_FAILED',
    } satisfies Partial<BusinessError>);

    expect(
      database.prepare('SELECT status FROM downloads WHERE id = ?').pluck().get(id),
    ).toBe('completed');
    await expect(access(outputPath)).resolves.toBeUndefined();
    expect(
      (await readdir(downloadRoot)).some((name) => name === '.vidharbor-delete'),
    ).toBe(false);

    failDeleteRm.enabled = false;
    await expect(deleteDownload(database, downloadRoot, id)).resolves.toBeUndefined();
    expect(database.prepare('SELECT id FROM downloads WHERE id = ?').get(id)).toBeUndefined();
    await expect(access(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps deleting when recursive rm partially removes the main media before failing', async () => {
    const insert = database
      .prepare(
        `INSERT INTO downloads (
          source_type, source_url, platform, platform_video_id, title,
          network_mode, archive_layout, status, output_path, output_size_bytes,
          created_at, finished_at
        ) VALUES (
          'direct', 'https://media.example/partial-delete', 'generic',
          'partial-delete', 'Partial', 'direct', 'download_directory',
          'completed', ?, 5, ?, ?
        )`,
      )
      .run(join(downloadRoot, 'pending-path'), NOW, NOW);
    const id = Number(insert.lastInsertRowid);
    const directory = join(downloadRoot, String(id));
    const mainName = 'partial-delete.mp4';
    const outputPath = join(directory, mainName);
    await mkdir(directory, { recursive: true });
    await writeFile(outputPath, 'media');
    await writeFile(join(directory, 'sidecar.txt'), 'extra');
    database
      .prepare(
        `UPDATE downloads
         SET output_path = ?, output_size_bytes = ?
         WHERE id = ?`,
      )
      .run(outputPath, Buffer.byteLength('media'), id);

    failDeleteRm.enabled = true;
    failDeleteRm.removeMainBeforeFail = mainName;

    await expect(deleteDownload(database, downloadRoot, id)).rejects.toMatchObject({
      code: 'DOWNLOAD_DELETE_FAILED',
    } satisfies Partial<BusinessError>);

    expect(
      database.prepare('SELECT status FROM downloads WHERE id = ?').pluck().get(id),
    ).toBe('deleting');
    await expect(access(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
    // Residual archive directory may remain after partial cleanup.
    await expect(access(directory)).resolves.toBeUndefined();
    await expect(access(join(directory, 'sidecar.txt'))).resolves.toBeUndefined();

    failDeleteRm.enabled = false;
    failDeleteRm.removeMainBeforeFail = null;
    await recoverDeletingDownloads(database, downloadRoot);
    expect(database.prepare('SELECT id FROM downloads WHERE id = ?').get(id)).toBeUndefined();
    await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['EACCES', 'EIO'] as const)(
    'does not hard-delete the row when realpath fails with %s instead of ENOENT',
    async (code) => {
      const { id, outputPath } = await insertCompletedLegacyDownload(
        `fault-${code}.webm`,
        `fault-${code}`,
      );
      database
        .prepare("UPDATE downloads SET status = 'deleting' WHERE id = ?")
        .run(id);
      realpathFault.code = code;
      realpathFault.match = outputPath;

      await expect(
        recoverDeletingDownloads(database, downloadRoot),
      ).rejects.toMatchObject({
        code: 'DOWNLOAD_DELETE_FAILED',
      } satisfies Partial<BusinessError>);

      expect(
        database.prepare('SELECT status FROM downloads WHERE id = ?').pluck().get(id),
      ).toBe('deleting');
      realpathFault.code = null;
      realpathFault.match = null;
      await expect(access(outputPath)).resolves.toBeUndefined();
    },
  );

  it('allows only one concurrent DELETE to own file cleanup for the same id', async () => {
    const { id, outputPath } = await insertCompletedLegacyDownload(
      'concurrent.webm',
      'concurrent-delete',
    );

    finalizeHold.arm();
    const owner = deleteDownload(database, downloadRoot, id);
    await vi.waitFor(() => {
      expect(
        database.prepare('SELECT status FROM downloads WHERE id = ?').pluck().get(id),
      ).toBe('deleting');
    });

    await expect(deleteDownload(database, downloadRoot, id)).rejects.toMatchObject({
      code: 'DOWNLOAD_DELETE_IN_PROGRESS',
    } satisfies Partial<BusinessError>);
    await expect(access(outputPath)).resolves.toBeUndefined();

    finalizeHold.release();
    await expect(owner).resolves.toBeUndefined();
    expect(database.prepare('SELECT id FROM downloads WHERE id = ?').get(id)).toBeUndefined();
    await expect(access(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns delete-in-progress without touching files for a pre-existing deleting row', async () => {
    const { id, outputPath } = await insertCompletedLegacyDownload(
      'in-progress.webm',
      'in-progress-delete',
    );
    database
      .prepare("UPDATE downloads SET status = 'deleting' WHERE id = ?")
      .run(id);

    await expect(deleteDownload(database, downloadRoot, id)).rejects.toMatchObject({
      code: 'DOWNLOAD_DELETE_IN_PROGRESS',
    } satisfies Partial<BusinessError>);

    expect(
      database.prepare('SELECT status FROM downloads WHERE id = ?').pluck().get(id),
    ).toBe('deleting');
    await expect(access(outputPath)).resolves.toBeUndefined();
  });

  it('startup recovery finishes a durable deleting row that still has archive files', async () => {
    const { id, outputPath } = await insertCompletedLegacyDownload(
      'startup.webm',
      'startup-recovery',
    );
    database
      .prepare("UPDATE downloads SET status = 'deleting' WHERE id = ?")
      .run(id);

    await recoverDeletingDownloads(database, downloadRoot);

    expect(database.prepare('SELECT id FROM downloads WHERE id = ?').get(id)).toBeUndefined();
    await expect(access(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('startup recovery drops a durable deleting row whose archive is already gone', async () => {
    const { id, outputPath } = await insertCompletedLegacyDownload(
      'gone.webm',
      'gone-recovery',
    );
    database
      .prepare("UPDATE downloads SET status = 'deleting' WHERE id = ?")
      .run(id);
    const { rm } = await import('node:fs/promises');
    await rm(outputPath);

    await recoverDeletingDownloads(database, downloadRoot);

    expect(database.prepare('SELECT id FROM downloads WHERE id = ?').get(id)).toBeUndefined();
  });

  it('blocks channel deletion while a download is in durable deleting state', async () => {
    const channel = database
      .prepare(
        `INSERT INTO channels (
          platform, extractor, platform_channel_id, source_url, custom_name,
          custom_name_key, proxy_id, check_interval_minutes, initial_sync_status,
          initial_synced_at, created_at, updated_at
        ) VALUES (
          'youtube', 'YoutubeTab', 'UC-delete-guard',
          'https://www.youtube.com/@delete-guard', 'Delete Guard', 'delete guard',
          NULL, NULL, 'succeeded', ?, ?, ?
        )`,
      )
      .run(NOW, NOW, NOW);
    const channelId = Number(channel.lastInsertRowid);
    const video = database
      .prepare(
        `INSERT INTO videos (
          channel_id, platform, platform_video_id, title, published_date,
          source_url, discovery_kind, discovered_at
        ) VALUES (?, 'youtube', 'video-delete-guard', 'Guard', '2026-07-01',
                  'https://www.youtube.com/watch?v=video-delete-guard',
                  'historical', ?)`,
      )
      .run(channelId, NOW);
    const videoId = Number(video.lastInsertRowid);
    const download = database
      .prepare(
        `INSERT INTO downloads (
          source_type, channel_id, video_id, source_url, platform,
          platform_video_id, title, published_date, network_mode, archive_layout,
          status, output_path, output_size_bytes, created_at, finished_at
        ) VALUES (
          'channel', ?, ?, 'https://www.youtube.com/watch?v=video-delete-guard',
          'youtube', 'video-delete-guard', 'Guard', '2026-07-01', 'direct',
          'download_directory', 'deleting', ?, ?, ?, ?
        )`,
      )
      .run(channelId, videoId, join(downloadRoot, 'placeholder'), 1, NOW, NOW);
    const downloadId = Number(download.lastInsertRowid);
    const directory = join(downloadRoot, String(downloadId));
    const outputPath = join(directory, 'video-delete-guard.mp4');
    await mkdir(directory, { recursive: true });
    await writeFile(outputPath, 'media');
    database
      .prepare(
        `UPDATE downloads
         SET output_path = ?, output_size_bytes = ?
         WHERE id = ?`,
      )
      .run(outputPath, Buffer.byteLength('media'), downloadId);

    const { deleteChannel } = await import('../../src/services/channel.js');
    expect(() => deleteChannel(database, channelId)).toThrowError(
      expect.objectContaining({ code: 'CHANNEL_IN_USE' }),
    );
    expect(
      database.prepare('SELECT id FROM channels WHERE id = ?').pluck().get(channelId),
    ).toBe(channelId);
  });
});
