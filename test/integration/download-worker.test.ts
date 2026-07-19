import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsControl = vi.hoisted(() => ({
  createTargetAtArchiveBoundary: false,
  rejectedRmPath: undefined as string | undefined,
  beforeRm: undefined as ((path: string) => Promise<void>) | undefined,
  rmPaths: [] as string[],
  rejectLink: false,
  linkPaths: [] as Array<readonly [string, string]>,
  copyPaths: [] as Array<readonly [string, string]>,
  afterStat: undefined as ((path: string) => void) | undefined,
  afterLink: undefined as ((path: string) => void) | undefined,
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>(
    'node:fs/promises',
  );
  const controlledRm: typeof actual.rm = async (path, options) => {
    const pathText = String(path);
    fsControl.rmPaths.push(pathText);
    if (pathText === fsControl.rejectedRmPath) {
      throw Object.assign(new Error(`EACCES: cannot remove ${String(path)}`), {
        code: 'EACCES',
      });
    }
    await fsControl.beforeRm?.(pathText);
    return actual.rm(path, options);
  };
  const controlledLink: typeof actual.link = async (oldPath, newPath) => {
    fsControl.linkPaths.push([String(oldPath), String(newPath)]);
    if (fsControl.createTargetAtArchiveBoundary) {
      await actual.writeFile(newPath, 'competing media');
    }
    if (fsControl.rejectLink) {
      throw Object.assign(new Error('EXDEV: cross-device link rejected'), {
        code: 'EXDEV',
      });
    }
    await actual.link(oldPath, newPath);
    fsControl.afterLink?.(String(newPath));
  };
  const controlledStat: typeof actual.stat = async (path, options) => {
    const result = await actual.stat(path, options as never);
    fsControl.afterStat?.(String(path));
    return result;
  };
  const controlledCopyFile: typeof actual.copyFile = async (
    source,
    destination,
    mode,
  ) => {
    fsControl.copyPaths.push([String(source), String(destination)]);
    return actual.copyFile(source, destination, mode);
  };
  return {
    ...actual,
    copyFile: controlledCopyFile,
    link: controlledLink,
    rm: controlledRm,
    stat: controlledStat,
  };
});

import { DownloadWorker } from '../../src/download-worker.js';
import {
  openDatabase,
  type DatabaseConnection,
  type Statement,
} from '../../src/db/client.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { formatFailureReason } from '../../src/redaction.js';
import type { QueuedDownload } from '../../src/services/download.js';
import { YtDlpTaskManager } from '../../src/yt-dlp-task-manager.js';

const FIRST_VIDEO_ID = 'aB_12-cD345';
const SECOND_VIDEO_ID = 'eF_67-gH890';
const PROXY_URL = 'http://alice:secret@proxy.example:8080';
const PROCESS_FIXTURE_PATH = fileURLToPath(
  new URL('../fixtures/fake-yt-dlp.mjs', import.meta.url),
);

let sandbox: string;
let downloadRoot: string;
let executablePath: string;
let database: DatabaseConnection;
let taskManager: YtDlpTaskManager | undefined;

function createWorker(
  connection: DatabaseConnection = database,
): DownloadWorker {
  const downloadConcurrency = database
    .prepare('SELECT download_concurrency FROM settings WHERE id = 1')
    .pluck()
    .get() as number;
  taskManager = new YtDlpTaskManager(
    executablePath,
    downloadConcurrency,
    (message) => formatFailureReason(message, [PROXY_URL]),
  );
  return new DownloadWorker(connection, taskManager);
}

function insertPending(platformVideoId: string): number {
  const result = database
    .prepare(
      `INSERT INTO downloads (
        source_type, source_url, platform, platform_video_id, title,
        network_mode, archive_layout, status, created_at
      ) VALUES ('direct', ?, 'youtube', ?, 'Title', 'direct', 'download_directory', 'pending', ?)`,
    )
    .run(
      `https://www.youtube.com/watch?v=${platformVideoId}`,
      platformVideoId,
      '2026-07-17T11:20:00.000Z',
    );
  return Number(result.lastInsertRowid);
}

function job(
  downloadId: number,
  platformVideoId: string,
  sourceUrl: string,
  _targetDirectory = downloadRoot,
  proxyUrl?: string,
): QueuedDownload {
  return {
    downloadId,
    sourceUrl,
    platformVideoId,
    downloadRoot,
    downloadsMountPath: downloadRoot,
    ...(proxyUrl === undefined ? {} : { proxyUrl }),
  };
}

function row(downloadId: number): Record<string, unknown> {
  return database.prepare('SELECT * FROM downloads WHERE id = ?').get(downloadId) as Record<
    string,
    unknown
  >;
}

function rejectCompletedUpdates(connection: DatabaseConnection): DatabaseConnection {
  const rejectingConnection: DatabaseConnection = {
    close: () => connection.close(),
    exec: (sql) => {
      connection.exec(sql);
      return rejectingConnection;
    },
    pragma: (source, options) => connection.pragma(source, options),
    prepare: (sql) => {
      const statement = connection.prepare(sql);
      if (!sql.includes("SET status = 'completed'")) {
        return statement;
      }
      const rejectingStatement: Statement = {
        all: (...parameters) => statement.all(...parameters),
        get: (...parameters) => statement.get(...parameters),
        pluck: (toggleState) => {
          statement.pluck(toggleState);
          return rejectingStatement;
        },
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
      };
      return rejectingStatement;
    },
  };
  return rejectingConnection;
}

function cancelBeforeCompletedUpdate(
  connection: DatabaseConnection,
): DatabaseConnection {
  const cancelingConnection: DatabaseConnection = {
    close: () => connection.close(),
    exec: (sql) => {
      connection.exec(sql);
      return cancelingConnection;
    },
    pragma: (source, options) => connection.pragma(source, options),
    prepare: (sql) => {
      const statement = connection.prepare(sql);
      if (sql.includes("SET status = 'completed'")) {
        void taskManager?.cancel(1);
      }
      return statement;
    },
  };
  return cancelingConnection;
}

function rejectUpdates(
  connection: DatabaseConnection,
  sqlFragment: string,
  error: Error,
): DatabaseConnection {
  const rejectingConnection: DatabaseConnection = {
    close: () => connection.close(),
    exec: (sql) => {
      connection.exec(sql);
      return rejectingConnection;
    },
    pragma: (source, options) => connection.pragma(source, options),
    prepare: (sql) => {
      const statement = connection.prepare(sql);
      if (!sql.includes(sqlFragment)) return statement;
      const rejectingStatement: Statement = {
        all: (...parameters) => statement.all(...parameters),
        get: (...parameters) => statement.get(...parameters),
        pluck: (toggleState) => {
          statement.pluck(toggleState);
          return rejectingStatement;
        },
        run: () => {
          throw error;
        },
      };
      return rejectingStatement;
    },
  };
  return rejectingConnection;
}

async function expectTaskDirectoryRemoved(downloadId: number): Promise<void> {
  await expect(readdir(join(downloadRoot, '.vidharbor-tmp', String(downloadId)))).rejects.toMatchObject({
    code: 'ENOENT',
  });
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

async function waitForProgress(downloadId: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (row(downloadId).progress_percent !== 42.5) {
    if (Date.now() >= deadline) throw new Error('download progress was not persisted');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'vidharbor-download-worker-'));
  downloadRoot = join(sandbox, 'downloads');
  await mkdir(downloadRoot);
  executablePath = PROCESS_FIXTURE_PATH;
  process.env.VIDHARBOR_FAKE_YT_DLP_DIR = sandbox;
  database = openDatabase(join(sandbox, 'vidharbor.sqlite'));
  migrateDatabase(database);
  taskManager = undefined;
});

afterEach(async () => {
  await taskManager?.stop();
  fsControl.createTargetAtArchiveBoundary = false;
  fsControl.rejectedRmPath = undefined;
  fsControl.beforeRm = undefined;
  fsControl.rmPaths.length = 0;
  fsControl.rejectLink = false;
  fsControl.linkPaths.length = 0;
  fsControl.copyPaths.length = 0;
  fsControl.afterStat = undefined;
  fsControl.afterLink = undefined;
  delete process.env.VIDHARBOR_FAKE_YT_DLP_DIR;
  try {
    database.close();
  } catch {
    // A test may intentionally close the database.
  }
  await rm(sandbox, { recursive: true, force: true });
});

describe('single download worker', () => {
  it('consumes FIFO without overlapping downloads', async () => {
    const firstId = insertPending(FIRST_VIDEO_ID);
    const secondId = insertPending(SECOND_VIDEO_ID);
    const worker = createWorker();

    worker.enqueue(job(firstId, FIRST_VIDEO_ID, 'fixture://worker-block-first'));
    worker.enqueue(job(secondId, SECOND_VIDEO_ID, 'fixture://worker-second'));

    await waitForFile(join(sandbox, 'first.running'));
    expect(row(firstId)).toMatchObject({ status: 'running' });
    expect(row(secondId)).toMatchObject({ status: 'pending' });
    expect(await readFile(join(sandbox, 'execution.log'), 'utf8')).toBe(
      'start:fixture://worker-block-first\n',
    );
    expect(taskManager?.getSnapshot()).toEqual([
      expect.objectContaining({ type: 'media_download', status: 'running' }),
      expect.objectContaining({ type: 'media_download', status: 'queued' }),
    ]);

    await writeFile(join(sandbox, 'first.release'), 'release');
    await worker.waitForIdle();

    expect(await readFile(join(sandbox, 'execution.log'), 'utf8')).toBe(
      'start:fixture://worker-block-first\nend:fixture://worker-block-first\n' +
        'start:fixture://worker-second\nend:fixture://worker-second\n',
    );
    expect(row(firstId)).toMatchObject({ status: 'completed' });
    expect(row(secondId)).toMatchObject({ status: 'completed' });
  });

  it('runs up to the configured download concurrency', async () => {
    database
      .prepare('UPDATE settings SET download_concurrency = 2 WHERE id = 1')
      .run();
    const firstId = insertPending(FIRST_VIDEO_ID);
    const secondId = insertPending(SECOND_VIDEO_ID);
    const worker = createWorker();

    worker.enqueue(job(firstId, FIRST_VIDEO_ID, 'fixture://worker-block-first'));
    worker.enqueue(job(secondId, SECOND_VIDEO_ID, 'fixture://worker-second'));

    await waitForFile(join(sandbox, 'first.running'));
    await waitForFile(join(downloadRoot, String(secondId), `${SECOND_VIDEO_ID}.mp4`));
    expect(row(firstId)).toMatchObject({ status: 'running' });
    expect(row(secondId)).toMatchObject({ status: 'completed' });

    await writeFile(join(sandbox, 'first.release'), 'release');
    await worker.waitForIdle();
    expect(row(firstId)).toMatchObject({ status: 'completed' });
  });

  it('waits for manager cancellation of an active download', async () => {
    const downloadId = insertPending(FIRST_VIDEO_ID);
    const worker = createWorker();

    worker.enqueue(job(downloadId, FIRST_VIDEO_ID, 'fixture://worker-block-first'));
    await waitForFile(join(sandbox, 'first.running'));
    await worker.cancel(downloadId);
    await worker.waitForIdle();

    expect(row(downloadId)).toMatchObject({
      status: 'canceled',
      failure_reason: 'yt-dlp download cancelled',
    });
    expect(taskManager?.getSnapshot()).toEqual([
      expect.objectContaining({ type: 'media_download', status: 'canceled' }),
    ]);
    await expectTaskDirectoryRemoved(downloadId);
  });

  it.each(['validation', 'archive', 'completion'] as const)(
    'observes manager cancellation at the %s boundary and rolls back',
    async (boundary) => {
      const downloadId = insertPending(FIRST_VIDEO_ID);
      const worker = createWorker(
        boundary === 'completion'
          ? cancelBeforeCompletedUpdate(database)
          : database,
      );
      const targetDirectory = join(downloadRoot, String(downloadId));
      const mediaFilename = `${FIRST_VIDEO_ID}.mp4`;
      if (boundary === 'validation') {
        fsControl.afterStat = (path) => {
          if (!path.endsWith(mediaFilename)) return;
          fsControl.afterStat = undefined;
          void taskManager?.cancel(1);
        };
      }
      if (boundary === 'archive') {
        fsControl.afterLink = (path) => {
          if (!path.endsWith(join(String(downloadId), mediaFilename))) return;
          fsControl.afterLink = undefined;
          void taskManager?.cancel(1);
        };
      }

      worker.enqueue(job(downloadId, FIRST_VIDEO_ID, 'fixture://worker-success'));
      await worker.waitForIdle();

      expect(row(downloadId)).toMatchObject({
        status: 'canceled',
        output_path: null,
        failure_reason: 'yt-dlp download cancelled',
      });
      expect(taskManager?.getSnapshot()).toEqual([
        expect.objectContaining({ type: 'media_download', status: 'canceled' }),
      ]);
      await expect(readdir(targetDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      await expectTaskDirectoryRemoved(downloadId);
    },
  );

  it('cancels during successful task cleanup before completion and rolls back', async () => {
    const downloadId = insertPending(FIRST_VIDEO_ID);
    const worker = createWorker();
    const realDownloadRoot = await realpath(downloadRoot);
    const taskDirectory = join(
      realDownloadRoot,
      '.vidharbor-tmp',
      String(downloadId),
    );
    const targetDirectory = join(realDownloadRoot, String(downloadId));
    let releaseCleanup!: () => void;
    const cleanupRelease = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let markCleanupStarted!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    fsControl.beforeRm = async (path) => {
      if (path !== taskDirectory) return;
      markCleanupStarted();
      await cleanupRelease;
    };

    worker.enqueue(job(downloadId, FIRST_VIDEO_ID, 'fixture://worker-success'));
    let cancellation: Promise<void> | undefined;
    try {
      await cleanupStarted;
      expect(row(downloadId)).toMatchObject({ status: 'running', output_path: null });
      await expect(readFile(join(targetDirectory, `${FIRST_VIDEO_ID}.mp4`), 'utf8'))
        .resolves.toBe('media');
      cancellation = taskManager?.cancel(1);
    } finally {
      releaseCleanup();
    }
    await cancellation;
    await worker.waitForIdle();

    expect(row(downloadId)).toMatchObject({
      status: 'canceled',
      output_path: null,
      failure_reason: 'yt-dlp download cancelled',
    });
    expect(taskManager?.getSnapshot()).toEqual([
      expect.objectContaining({ type: 'media_download', status: 'canceled' }),
    ]);
    await expect(readdir(targetDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expectTaskDirectoryRemoved(downloadId);
  });

  it('cancels a queued manager task without starting its process', async () => {
    const firstId = insertPending(FIRST_VIDEO_ID);
    const secondId = insertPending(SECOND_VIDEO_ID);
    const worker = createWorker();

    worker.enqueue(job(firstId, FIRST_VIDEO_ID, 'fixture://worker-block-first'));
    worker.enqueue(job(secondId, SECOND_VIDEO_ID, 'fixture://worker-second'));
    await waitForFile(join(sandbox, 'first.running'));

    await worker.cancel(secondId);
    expect(row(secondId)).toMatchObject({ status: 'pending' });
    expect(taskManager?.getSnapshot()[1]).toMatchObject({
      type: 'media_download',
      status: 'canceled',
      startedAt: null,
    });

    await writeFile(join(sandbox, 'first.release'), 'release');
    await worker.waitForIdle();
    expect(await readFile(join(sandbox, 'execution.log'), 'utf8')).toBe(
      'start:fixture://worker-block-first\nend:fixture://worker-block-first\n',
    );
  });

  it('persists stderr progress while active and clears transient metrics on completion', async () => {
    const downloadId = insertPending(FIRST_VIDEO_ID);
    const worker = createWorker();

    worker.enqueue(job(downloadId, FIRST_VIDEO_ID, 'fixture://worker-progress-block'));
    await waitForFile(join(sandbox, 'progress.running'));
    await waitForProgress(downloadId);

    expect(row(downloadId)).toMatchObject({
      status: 'running',
      progress_percent: 42.5,
      speed_text: '1.2MiB/s',
      eta_seconds: 17,
    });

    await writeFile(join(sandbox, 'progress.release'), 'release');
    await worker.waitForIdle();

    expect(row(downloadId)).toMatchObject({
      status: 'completed',
      progress_percent: 100,
      speed_text: null,
      eta_seconds: null,
      exit_code: 0,
    });
  });

  it('does not execute a queued download whose persisted state is not pending', async () => {
    const downloadId = insertPending(FIRST_VIDEO_ID);
    database
      .prepare(
        `UPDATE downloads
         SET status = 'failed', failure_reason = 'already failed', finished_at = ?
         WHERE id = ?`,
      )
      .run('2026-07-17T11:21:00.000Z', downloadId);
    const worker = createWorker();

    worker.enqueue(job(downloadId, FIRST_VIDEO_ID, 'fixture://worker-success'));

    await expect(worker.waitForIdle()).rejects.toThrow('download is not pending');
    expect(row(downloadId)).toMatchObject({
      status: 'failed',
      failure_reason: 'already failed',
    });
    await expect(readFile(join(sandbox, 'argv.log'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('archives channel and direct downloads in their download ID directories', async () => {
    const channelDirectory = join(downloadRoot, 'Saved channel', '2026');
    const channelId = insertPending(FIRST_VIDEO_ID);
    const directId = insertPending(SECOND_VIDEO_ID);
    const worker = createWorker();

    worker.enqueue(
      job(channelId, FIRST_VIDEO_ID, 'fixture://worker-channel', channelDirectory),
    );
    worker.enqueue(job(directId, SECOND_VIDEO_ID, 'fixture://worker-second'));
    await worker.waitForIdle();

    const channelPath = join(downloadRoot, String(channelId), `${FIRST_VIDEO_ID}.mp4`);
    const directPath = join(downloadRoot, String(directId), `${SECOND_VIDEO_ID}.mp4`);
    const channelThumbnailPath = join(downloadRoot, String(channelId), `${FIRST_VIDEO_ID}.jpg`);
    await expect(readFile(channelPath, 'utf8')).resolves.toBe('media');
    await expect(readFile(directPath, 'utf8')).resolves.toBe('media');
    await expect(readFile(channelThumbnailPath, 'utf8')).resolves.toBe('thumbnail');
    const realChannelPath = await realpath(channelPath);
    const realDirectPath = await realpath(directPath);
    const realDownloadRoot = await realpath(downloadRoot);
    expect(row(channelId)).toMatchObject({
      status: 'completed',
      output_path: realChannelPath,
      thumbnail_path: await realpath(channelThumbnailPath),
      output_size_bytes: Buffer.byteLength('media'),
      failure_reason: null,
      started_at: expect.any(String),
      finished_at: expect.any(String),
    });
    expect(row(directId)).toMatchObject({
      status: 'completed',
      output_path: realDirectPath,
      output_size_bytes: Buffer.byteLength('media'),
    });
    await expectTaskDirectoryRemoved(channelId);
    await expectTaskDirectoryRemoved(directId);
    expect(fsControl.linkPaths).toContainEqual([
      join(realDownloadRoot, '.vidharbor-tmp', String(channelId), `${FIRST_VIDEO_ID}.mp4`),
      realChannelPath,
    ]);
    expect(fsControl.linkPaths).toContainEqual([
      join(realDownloadRoot, '.vidharbor-tmp', String(directId), `${SECOND_VIDEO_ID}.mp4`),
      realDirectPath,
    ]);
  });

  it('completes the video when the optional thumbnail download fails', async () => {
    const downloadId = insertPending(FIRST_VIDEO_ID);
    const worker = createWorker();
    worker.enqueue(job(
      downloadId,
      FIRST_VIDEO_ID,
      'fixture://worker-thumbnail-failure',
    ));
    await worker.waitForIdle();

    expect(row(downloadId)).toMatchObject({
      status: 'completed',
      thumbnail_path: null,
    });
    expect(await readdir(join(downloadRoot, String(downloadId))))
      .toEqual([`${FIRST_VIDEO_ID}.mp4`]);
  });

  it('propagates a non-cancellation thumbnail error when the task signal is aborted', async () => {
    const blockingExecutable = join(sandbox, 'blocking-thumbnail.mjs');
    await writeFile(
      blockingExecutable,
      `#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const args = process.argv.slice(2);
const output = args[args.indexOf('--output') + 1];
const controlDirectory = process.env.VIDHARBOR_FAKE_YT_DLP_DIR;
if (args.includes('--skip-download')) {
  await writeFile(join(controlDirectory, 'thumbnail.running'), 'running');
  setInterval(() => undefined, 1_000);
} else {
  const filepath = output.replace('%(id)s', '${FIRST_VIDEO_ID}').replace('%(ext)s', 'mp4');
  await mkdir(dirname(filepath), { recursive: true });
  await writeFile(filepath, 'media');
  process.stdout.write(filepath + '\\n');
}
`,
    );
    await chmod(blockingExecutable, 0o755);
    executablePath = blockingExecutable;
    const downloadId = insertPending(FIRST_VIDEO_ID);
    const worker = createWorker();
    const processKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid < 0) throw new Error('thumbnail termination exploded');
      return processKill(pid, signal);
    });

    try {
      worker.enqueue(job(downloadId, FIRST_VIDEO_ID, 'fixture://thumbnail-cancel'));
      await waitForFile(join(sandbox, 'thumbnail.running'));
      await taskManager?.cancel(1);
      await worker.waitForIdle();
    } finally {
      killSpy.mockRestore();
    }

    expect(row(downloadId)).toMatchObject({
      status: 'canceled',
      output_path: null,
      failure_reason: expect.stringContaining('thumbnail termination exploded'),
    });
    await expect(readdir(join(downloadRoot, String(downloadId))))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expectTaskDirectoryRemoved(downloadId);
  });

  it('passes exactly one configured proxy argument and no proxy argument for direct', async () => {
    const proxyId = insertPending(FIRST_VIDEO_ID);
    const directId = insertPending(SECOND_VIDEO_ID);
    const worker = createWorker();

    worker.enqueue(
      job(
        proxyId,
        FIRST_VIDEO_ID,
        'fixture://worker-proxy',
        downloadRoot,
        PROXY_URL,
      ),
    );
    worker.enqueue(job(directId, SECOND_VIDEO_ID, 'fixture://worker-second'));
    await worker.waitForIdle();

    const invocations = (await readFile(join(sandbox, 'argv.log'), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    const proxyArguments = invocations[0]?.flatMap((argument, index, all) =>
      argument === '--proxy' ? [all[index + 1]] : [],
    );
    expect(proxyArguments).toEqual([PROXY_URL]);
    expect(invocations[1]).not.toContain('--proxy');
  });

  it('persists a redacted process failure and continues with the next FIFO item', async () => {
    const failedId = insertPending(FIRST_VIDEO_ID);
    const successfulId = insertPending(SECOND_VIDEO_ID);
    const worker = createWorker();

    worker.enqueue(
      job(
        failedId,
        FIRST_VIDEO_ID,
        'fixture://worker-exit-failure',
        downloadRoot,
        PROXY_URL,
      ),
    );
    worker.enqueue(job(successfulId, SECOND_VIDEO_ID, 'fixture://worker-second'));
    await worker.waitForIdle();

    expect(row(failedId)).toMatchObject({
      status: 'failed',
      output_path: null,
      failure_reason: expect.stringContaining('exit code 7'),
      finished_at: expect.any(String),
    });
    expect(JSON.stringify(row(failedId))).not.toContain('alice');
    expect(JSON.stringify(row(failedId))).not.toContain('secret');
    expect(row(successfulId)).toMatchObject({ status: 'completed' });
    expect(taskManager?.getSnapshot()).toEqual([
      expect.objectContaining({ type: 'media_download', status: 'failed' }),
      expect.objectContaining({ type: 'media_download', status: 'succeeded' }),
    ]);
    await expectTaskDirectoryRemoved(failedId);
  });

  it.each([
    ['no file', 'fixture://worker-no-file'],
    ['a zero-byte file', 'fixture://worker-zero'],
  ])('fails and cleans the task for %s', async (_caseName, sourceUrl) => {
    const downloadId = insertPending(FIRST_VIDEO_ID);
    const worker = createWorker();

    worker.enqueue(job(downloadId, FIRST_VIDEO_ID, sourceUrl));
    await worker.waitForIdle();

    expect(row(downloadId)).toMatchObject({
      status: 'failed',
      output_path: null,
      failure_reason: expect.any(String),
    });
    await expectTaskDirectoryRemoved(downloadId);
  });

  it('archives multiple regular artifacts in one download directory', async () => {
    const downloadId = insertPending(FIRST_VIDEO_ID);
    const worker = createWorker();
    worker.enqueue(job(downloadId, FIRST_VIDEO_ID, 'fixture://worker-multiple'));
    await worker.waitForIdle();

    expect(row(downloadId)).toMatchObject({ status: 'completed' });
    expect(await readdir(join(downloadRoot, String(downloadId)))).toEqual(
      expect.arrayContaining([`${FIRST_VIDEO_ID}.mp4`, 'extra.webm']),
    );
  });

  it('rejects an outside reported path when the task directory has one valid file', async () => {
    const downloadId = insertPending(FIRST_VIDEO_ID);
    const worker = createWorker();

    worker.enqueue(job(downloadId, FIRST_VIDEO_ID, 'fixture://worker-outside'));
    await worker.waitForIdle();

    expect(row(downloadId)).toMatchObject({
      status: 'failed',
      output_path: null,
      failure_reason: 'after_move filepath is outside the task directory',
    });
    await expectTaskDirectoryRemoved(downloadId);
  });

  it('does not overwrite an existing final target', async () => {
    const downloadId = insertPending(FIRST_VIDEO_ID);
    const existingDirectory = join(downloadRoot, String(downloadId));
    await mkdir(existingDirectory);
    const existingPath = join(existingDirectory, 'existing.webm');
    await writeFile(existingPath, 'existing');
    const worker = createWorker();

    worker.enqueue(job(downloadId, FIRST_VIDEO_ID, 'fixture://worker-success'));
    await worker.waitForIdle();

    await expect(readFile(existingPath, 'utf8')).resolves.toBe('existing');
    expect(row(downloadId)).toMatchObject({ status: 'failed', output_path: null });
    await expectTaskDirectoryRemoved(downloadId);
  });

  it('does not overwrite a final target created at the archive boundary', async () => {
    const downloadId = insertPending(FIRST_VIDEO_ID);
    const targetDirectory = join(downloadRoot, String(downloadId));
    const worker = createWorker();
    fsControl.createTargetAtArchiveBoundary = true;

    worker.enqueue(job(downloadId, FIRST_VIDEO_ID, 'fixture://worker-success'));
    await worker.waitForIdle();

    const competingFiles = await readdir(targetDirectory);
    expect(competingFiles).toHaveLength(1);
    await expect(readFile(join(targetDirectory, competingFiles[0] as string), 'utf8'))
      .resolves.toBe('competing media');
    expect(row(downloadId)).toMatchObject({
      status: 'failed',
      output_path: null,
      failure_reason: 'final target already exists',
    });
    await expectTaskDirectoryRemoved(downloadId);
  });

  it('fails on EXDEV at the link boundary without copying the download', async () => {
    const realDownloadRoot = await realpath(downloadRoot);
    const downloadId = insertPending(FIRST_VIDEO_ID);
    const targetPath = join(realDownloadRoot, String(downloadId), `${FIRST_VIDEO_ID}.mp4`);
    const worker = createWorker();
    fsControl.rejectLink = true;

    worker.enqueue(job(downloadId, FIRST_VIDEO_ID, 'fixture://worker-success'));
    await worker.waitForIdle();

    expect(fsControl.linkPaths.at(-1)).toEqual([
      join(realDownloadRoot, '.vidharbor-tmp', String(downloadId), `${FIRST_VIDEO_ID}.mp4`),
      join(realDownloadRoot, String(downloadId), `${FIRST_VIDEO_ID}.mp4`),
    ]);
    expect(fsControl.copyPaths).toEqual([]);
    await expect(readFile(targetPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(row(downloadId)).toMatchObject({
      status: 'failed',
      output_path: null,
      failure_reason: expect.stringContaining('EXDEV'),
    });
    await expectTaskDirectoryRemoved(downloadId);
  });

  it('rolls back its archived file when completed persistence is rejected', async () => {
    const targetPath = join(downloadRoot, `${FIRST_VIDEO_ID}.mp4`);
    const downloadId = insertPending(FIRST_VIDEO_ID);
    const worker = createWorker(rejectCompletedUpdates(database));

    worker.enqueue(job(downloadId, FIRST_VIDEO_ID, 'fixture://worker-success'));
    await worker.waitForIdle();

    await expect(readFile(targetPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(row(downloadId)).toMatchObject({ status: 'failed', output_path: null });
    await expectTaskDirectoryRemoved(downloadId);
  });

  it('stops the queue and rejects idle when the running transition fails', async () => {
    const firstId = insertPending(FIRST_VIDEO_ID);
    const secondId = insertPending(SECOND_VIDEO_ID);
    const worker = createWorker(
      rejectUpdates(
        database,
        "SET status = 'running'",
        new Error(`running persistence rejected for ${PROXY_URL}`),
      ),
    );

    worker.enqueue(
      job(
        firstId,
        FIRST_VIDEO_ID,
        'fixture://worker-first',
        downloadRoot,
        PROXY_URL,
      ),
    );
    worker.enqueue(job(secondId, SECOND_VIDEO_ID, 'fixture://worker-second'));

    await expect(worker.waitForIdle()).rejects.toThrow(
      'running persistence rejected for http://***@proxy.example:8080',
    );
    expect(row(firstId)).toMatchObject({ status: 'pending' });
    expect(row(secondId)).toMatchObject({ status: 'pending' });
    await expect(readFile(join(sandbox, 'execution.log'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });

    expect(() =>
      worker.enqueue(job(secondId, SECOND_VIDEO_ID, 'fixture://worker-second')),
    ).toThrow(
      'running persistence rejected for http://***@proxy.example:8080',
    );
  });

  it('stops the queue and rejects idle when failed persistence fails', async () => {
    const firstId = insertPending(FIRST_VIDEO_ID);
    const secondId = insertPending(SECOND_VIDEO_ID);
    const worker = createWorker(
      rejectUpdates(
        database,
        "SET status = ?, failure_reason",
        new Error(`failed persistence rejected for ${PROXY_URL}`),
      ),
    );

    worker.enqueue(
      job(
        firstId,
        FIRST_VIDEO_ID,
        'fixture://worker-exit-failure',
        downloadRoot,
        PROXY_URL,
      ),
    );
    worker.enqueue(job(secondId, SECOND_VIDEO_ID, 'fixture://worker-second'));

    await expect(worker.waitForIdle()).rejects.toThrow(
      'failed persistence rejected for http://***@proxy.example:8080',
    );
    expect(row(firstId)).toMatchObject({ status: 'running' });
    expect(row(secondId)).toMatchObject({ status: 'pending' });
    expect(await readFile(join(sandbox, 'execution.log'), 'utf8')).toBe(
      'start:fixture://worker-exit-failure\n',
    );
  });

  it('persists and propagates task cleanup failure without draining the queue', async () => {
    const firstId = insertPending(FIRST_VIDEO_ID);
    const secondId = insertPending(SECOND_VIDEO_ID);
    const worker = createWorker();
    const taskDirectory = join(downloadRoot, '.vidharbor-tmp', String(firstId));
    fsControl.rejectedRmPath = join(
      await realpath(downloadRoot),
      '.vidharbor-tmp',
      String(firstId),
    );

    worker.enqueue(
      job(
        firstId,
        FIRST_VIDEO_ID,
        'fixture://worker-cleanup-failure-exit-failure',
        downloadRoot,
        PROXY_URL,
      ),
    );
    worker.enqueue(job(secondId, SECOND_VIDEO_ID, 'fixture://worker-second'));

    const idleResult = await worker.waitForIdle().catch((error: unknown) => error);
    expect(fsControl.rmPaths).toContain(fsControl.rejectedRmPath);
    expect(idleResult).toBeInstanceOf(Error);
    expect((idleResult as Error).message).toMatch(/EACCES|EPERM/);
    expect(row(firstId)).toMatchObject({
      status: 'failed',
      failure_reason: expect.stringMatching(/EACCES|EPERM/),
    });
    expect(row(secondId)).toMatchObject({ status: 'pending' });
    await expect(readdir(taskDirectory)).resolves.toEqual([]);
    fsControl.rejectedRmPath = undefined;
  });

  it('revalidates the download root before starting external work', async () => {
    const downloadId = insertPending(FIRST_VIDEO_ID);
    await rm(downloadRoot, { recursive: true });
    const worker = createWorker();

    worker.enqueue(job(downloadId, FIRST_VIDEO_ID, 'fixture://worker-success'));
    await worker.waitForIdle();

    expect(row(downloadId)).toMatchObject({ status: 'failed', output_path: null });
    await expect(readFile(join(sandbox, 'execution.log'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not clean through a download-root symlink outside the mount', async () => {
    const downloadId = insertPending(FIRST_VIDEO_ID);
    const outsideRoot = join(sandbox, 'outside');
    const outsideTaskDirectory = join(
      outsideRoot,
      '.vidharbor-tmp',
      String(downloadId),
    );
    await mkdir(outsideTaskDirectory, { recursive: true });
    await writeFile(join(outsideTaskDirectory, 'preserve.txt'), 'preserve');
    await rm(downloadRoot, { recursive: true });
    await symlink(outsideRoot, downloadRoot);
    const worker = createWorker();

    worker.enqueue(job(downloadId, FIRST_VIDEO_ID, 'fixture://worker-success'));
    await worker.waitForIdle();

    await expect(readFile(join(outsideTaskDirectory, 'preserve.txt'), 'utf8')).resolves.toBe(
      'preserve',
    );
    expect(row(downloadId)).toMatchObject({ status: 'failed' });
  });
});
