import {
  access,
  constants,
  link,
  mkdir,
  readdir,
  realpath,
  rmdir,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { DatabaseConnection } from './db/client.js';
import { validateDownloadRoot } from './filesystem.js';
import { redactStderr } from './redaction.js';
import type {
  DownloadQueue,
  QueuedDownload,
} from './services/download.js';
import { downloadMedia, downloadThumbnail } from './yt-dlp.js';

const RESTART_FAILURE_REASON = 'service restarted before task completed';

interface InterruptedDownloadRow {
  readonly id: number;
}

interface InterruptedDownloadCleanupFailure {
  readonly downloadId: number;
  readonly error: unknown;
}

export function listInterruptedDownloadIds(
  database: DatabaseConnection,
): number[] {
  const interruptedRows = database
    .prepare(
      `SELECT id
       FROM downloads
       WHERE status IN ('pending', 'downloading', 'running')
       ORDER BY id`,
    )
    .all() as InterruptedDownloadRow[];
  return interruptedRows.map((row) => row.id);
}

export function listDownloadIds(database: DatabaseConnection): number[] {
  return database
    .prepare('SELECT id FROM downloads ORDER BY id')
    .pluck()
    .all() as number[];
}

export function recoverInterruptedDownloads(
  database: DatabaseConnection,
  downloadIds: readonly number[],
  finishedAt: string,
): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    const update = database.prepare(
        `UPDATE downloads
         SET status = 'interrupted', failure_reason = ?, speed_text = NULL,
             eta_seconds = NULL, finished_at = ?
         WHERE id = ? AND status IN ('pending', 'downloading', 'running')`,
      );
    let changes = 0;
    for (const downloadId of downloadIds) {
      changes += update.run(RESTART_FAILURE_REASON, finishedAt, downloadId).changes;
    }
    if (changes !== downloadIds.length) {
      throw new Error('interrupted download recovery changed an unexpected number of records');
    }

    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export async function cleanupInterruptedDownloadDirectories(
  downloadRoot: string,
  downloadIds: readonly number[],
): Promise<InterruptedDownloadCleanupFailure[]> {
  const realDownloadRoot = await realpath(downloadRoot);
  const temporaryRoot = join(realDownloadRoot, '.vidharbor-tmp');
  let realTemporaryRoot: string;
  try {
    realTemporaryRoot = await realpath(temporaryRoot);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return [];
    }
    return downloadIds.map((downloadId) => ({ downloadId, error }));
  }

  const temporaryRootStat = await stat(realTemporaryRoot);
  if (!temporaryRootStat.isDirectory()) {
    const error = new Error('ENOTDIR: temporary root is not a directory');
    return downloadIds.map((downloadId) => ({ downloadId, error }));
  }
  if (!isContained(realDownloadRoot, realTemporaryRoot)) {
    const error = new Error('temporary root is outside download root');
    return downloadIds.map((downloadId) => ({ downloadId, error }));
  }

  const failures: InterruptedDownloadCleanupFailure[] = [];
  for (const downloadId of downloadIds) {
    try {
      const candidatePath = join(realTemporaryRoot, String(downloadId));
      let realTaskDirectory: string;
      try {
        realTaskDirectory = await realpath(candidatePath);
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          continue;
        }
        throw error;
      }
      if (realTaskDirectory !== candidatePath) {
        throw new Error('task directory must not be a symbolic link');
      }
      if (!isContained(realTemporaryRoot, realTaskDirectory)) {
        throw new Error('task directory is outside temporary root');
      }
      await rm(realTaskDirectory, {
        recursive: true,
        force: true,
      });
    } catch (error) {
      failures.push({ downloadId, error });
    }
  }
  return failures;
}

function isContained(basePath: string, candidatePath: string): boolean {
  const relativePath = relative(basePath, candidatePath);
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function failureMessage(error: unknown, proxyUrl: string | undefined): string {
  const message = error instanceof Error ? error.message : 'download failed';
  return redactStderr(message, proxyUrl === undefined ? [] : [proxyUrl]);
}

async function ensureDirectoryWithin(
  directory: string,
  downloadRoot: string,
): Promise<string> {
  const realDirectory = await realpath(directory);
  const directoryStat = await stat(realDirectory);
  if (!directoryStat.isDirectory() || !isContained(downloadRoot, realDirectory)) {
    throw new Error('directory is outside download root');
  }
  return realDirectory;
}

async function createTaskDirectory(
  downloadRoot: string,
  downloadId: number,
): Promise<string> {
  const temporaryRoot = resolve(downloadRoot, '.vidharbor-tmp');
  try {
    await mkdir(temporaryRoot);
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'EEXIST'
    ) {
      throw error;
    }
  }

  const realTemporaryRoot = await ensureDirectoryWithin(
    temporaryRoot,
    downloadRoot,
  );
  const taskDirectory = resolve(realTemporaryRoot, String(downloadId));
  if (!isContained(realTemporaryRoot, taskDirectory)) {
    throw new Error('task directory is outside temporary root');
  }
  await mkdir(taskDirectory);
  return ensureDirectoryWithin(taskDirectory, downloadRoot);
}

async function validateDownloadedFiles(
  taskDirectory: string,
  reportedPath: string,
): Promise<{ readonly mainFilename: string; readonly filenames: readonly string[] }> {
  if (!isAbsolute(reportedPath)) {
    throw new Error('after_move filepath must be absolute');
  }

  const realReportedPath = await realpath(resolve(reportedPath));
  if (!isContained(taskDirectory, realReportedPath) || realReportedPath === taskDirectory) {
    throw new Error('after_move filepath is outside the task directory');
  }
  const entries = await readdir(taskDirectory, { withFileTypes: true });
  if (entries.length === 0) throw new Error('task directory contains no files');
  for (const entry of entries) {
    if (!entry.isFile()) throw new Error('task directory contains a non-file entry');
    const path = resolve(taskDirectory, entry.name);
    const realPath = await realpath(path);
    const fileStat = await stat(realPath);
    if (!isContained(taskDirectory, realPath) || !fileStat.isFile() || fileStat.size === 0) {
      throw new Error('downloaded artifacts must be non-empty regular files');
    }
    await access(realPath, constants.R_OK);
  }
  const mainFilename = realReportedPath.slice(taskDirectory.length + 1);
  if (mainFilename.includes(sep) || !entries.some((entry) => entry.name === mainFilename)) {
    throw new Error('after_move filepath is outside the task directory');
  }
  const extension = extname(mainFilename);
  if (extension.length < 2) {
    throw new Error('downloaded file has no final extension');
  }
  return { mainFilename, filenames: entries.map((entry) => entry.name) };
}

async function tryDownloadThumbnail(
  executablePath: string,
  taskDirectory: string,
  download: QueuedDownload,
  signal: AbortSignal,
): Promise<string | undefined> {
  const thumbnailDirectory = join(taskDirectory, '.thumbnail');
  try {
    await mkdir(thumbnailDirectory);
    await downloadThumbnail({
      executablePath,
      url: download.sourceUrl,
      outputTemplate: join(thumbnailDirectory, '%(id)s.%(ext)s'),
      signal,
      ...(download.proxyUrl === undefined ? {} : { proxyUrl: download.proxyUrl }),
    });
    const entries = await readdir(thumbnailDirectory, { withFileTypes: true });
    if (entries.length !== 1 || entries[0]?.isFile() !== true) return undefined;
    const thumbnail = entries[0];
    const sourcePath = join(thumbnailDirectory, thumbnail.name);
    if ((await stat(sourcePath)).size === 0) return undefined;
    const targetPath = join(taskDirectory, thumbnail.name);
    await link(sourcePath, targetPath);
    return thumbnail.name;
  } catch {
    return undefined;
  } finally {
    await rm(thumbnailDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export class DownloadWorker implements DownloadQueue {
  readonly failure: Promise<never>;
  readonly #database: DatabaseConnection;
  readonly #ytDlpExecutablePath: string;
  readonly #queue: QueuedDownload[] = [];
  readonly #maxConcurrency: number;
  readonly #idleWaiters: Array<{
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
  }> = [];
  #activeCount = 0;
  #stopping = false;
  #failure: Error | undefined;
  #rejectFailure!: (error: Error) => void;
  readonly #activeDownloads = new Map<number, AbortController>();

  constructor(database: DatabaseConnection, ytDlpExecutablePath: string) {
    this.#database = database;
    this.#ytDlpExecutablePath = ytDlpExecutablePath;
    const configuredConcurrency = database
      .prepare('SELECT download_concurrency FROM settings WHERE id = 1')
      .pluck()
      .get();
    if (
      typeof configuredConcurrency !== 'number' ||
      !Number.isSafeInteger(configuredConcurrency) ||
      configuredConcurrency < 1
    ) {
      throw new Error('download concurrency is invalid');
    }
    this.#maxConcurrency = configuredConcurrency;
    this.failure = new Promise<never>((_resolve, reject) => {
      this.#rejectFailure = reject;
    });
    void this.failure.catch(() => undefined);
  }

  enqueue(download: QueuedDownload): void {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#stopping) throw new Error('download worker is stopped');
    this.#queue.push(download);
    this.#schedule();
  }

  cancel(downloadId: number): void {
    this.#activeDownloads.get(downloadId)?.abort();
    const index = this.#queue.findIndex((download) => download.downloadId === downloadId);
    if (index !== -1) {
      this.#queue.splice(index, 1);
    }
  }

  waitForIdle(): Promise<void> {
    if (this.#failure !== undefined) {
      return Promise.reject(this.#failure);
    }
    if (this.#activeCount === 0 && this.#queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolvePromise, rejectPromise) => {
      this.#idleWaiters.push({ resolve: resolvePromise, reject: rejectPromise });
    });
  }

  stop(): void {
    this.#stopping = true;
    this.#queue.length = 0;
    for (const controller of this.#activeDownloads.values()) controller.abort();
  }

  #schedule(): void {
    if (this.#failure !== undefined || this.#stopping) {
      if (this.#activeCount === 0) this.#settleIdleWaiters();
      return;
    }
    while (this.#activeCount < this.#maxConcurrency && this.#queue.length > 0) {
      const download = this.#queue.shift();
      if (download === undefined) continue;
      this.#activeCount += 1;
      void this.#runAndContinue(download);
    }
    if (this.#activeCount === 0 && this.#queue.length === 0) {
      this.#settleIdleWaiters();
    }
  }

  async #runAndContinue(download: QueuedDownload): Promise<void> {
    try {
      await this.#run(download);
    } catch (error) {
      this.#failure =
        error instanceof Error ? error : new Error('download worker failed');
      this.#rejectFailure(this.#failure);
      this.#queue.length = 0;
      for (const controller of this.#activeDownloads.values()) controller.abort();
    } finally {
      this.#activeCount -= 1;
      this.#schedule();
    }
  }

  #settleIdleWaiters(): void {
    for (const waiter of this.#idleWaiters.splice(0)) {
      if (this.#failure === undefined) waiter.resolve();
      else waiter.reject(this.#failure);
    }
  }

  async #run(download: QueuedDownload): Promise<void> {
    const abortController = new AbortController();
    this.#activeDownloads.set(download.downloadId, abortController);
    let taskDirectory: string | undefined;
    let started = false;
    let archivedDirectory: string | undefined;
    const archivedFiles: string[] = [];
    let boundaryFailure: Error | undefined;

    try {
      const startedAt = new Date().toISOString();
      const transition = this.#database
        .prepare(
          `UPDATE downloads
           SET status = 'running', started_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(startedAt, download.downloadId);
      if (transition.changes !== 1) {
        throw new Error('download is not pending');
      }
      started = true;

      const realDownloadRoot = await validateDownloadRoot(
        download.downloadRoot,
        download.downloadsMountPath,
      );
      taskDirectory = await createTaskDirectory(
        realDownloadRoot,
        download.downloadId,
      );

      const persistProgress = (progress: {
        readonly progressPercent: number;
        readonly speedText: string | null;
        readonly etaSeconds: number | null;
      }) => {
        this.#database
          .prepare(
            `UPDATE downloads
             SET progress_percent = ?, speed_text = ?, eta_seconds = ?
             WHERE id = ? AND status = 'running'`,
          )
          .run(
            progress.progressPercent,
            progress.speedText,
            progress.etaSeconds,
            download.downloadId,
          );
      };
      const reportedPath = await downloadMedia({
        executablePath: this.#ytDlpExecutablePath,
        url: download.sourceUrl,
        outputTemplate: join(taskDirectory, '%(id)s.%(ext)s'),
        signal: abortController.signal,
        onProgress: persistProgress,
        ...(download.advancedOptions === undefined
          ? {}
          : { advancedOptions: download.advancedOptions }),
        ...(download.proxyUrl === undefined
          ? {}
          : { proxyUrl: download.proxyUrl }),
      });
      const thumbnailFilename = await tryDownloadThumbnail(
        this.#ytDlpExecutablePath,
        taskDirectory,
        download,
        abortController.signal,
      );
      if (abortController.signal.aborted) throw new Error('yt-dlp download cancelled');
      const downloadedFiles = await validateDownloadedFiles(
        taskDirectory,
        reportedPath,
      );
      const targetDirectory = join(realDownloadRoot, String(download.downloadId));
      try {
        await mkdir(targetDirectory);
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
          throw new Error('final download directory already exists');
        }
        throw error;
      }
      archivedDirectory = targetDirectory;
      for (const filename of downloadedFiles.filenames) {
        const archivedPath = join(targetDirectory, filename);
        try {
          await link(join(taskDirectory, filename), archivedPath);
        } catch (error) {
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
            throw new Error('final target already exists');
          }
          throw error;
        }
        archivedFiles.push(archivedPath);
      }
      const targetPath = join(targetDirectory, downloadedFiles.mainFilename);
      const thumbnailPath = thumbnailFilename === undefined
        ? null
        : join(targetDirectory, thumbnailFilename);

      const completed = this.#database
        .prepare(
          `UPDATE downloads
           SET status = 'completed', output_path = ?, thumbnail_path = ?,
               progress_percent = 100,
               speed_text = NULL, eta_seconds = NULL, exit_code = 0,
               finished_at = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(targetPath, thumbnailPath, new Date().toISOString(), download.downloadId);
      if (completed.changes !== 1) {
        throw new Error('download completion state transition failed');
      }
      archivedDirectory = undefined;
    } catch (error) {
      let failure = error;
      if (archivedDirectory !== undefined) {
        try {
          for (const archivedFile of archivedFiles) await unlink(archivedFile);
          await rmdir(archivedDirectory);
          archivedDirectory = undefined;
        } catch (rollbackError) {
          if (
            typeof rollbackError !== 'object' ||
            rollbackError === null ||
            !('code' in rollbackError) ||
            rollbackError.code !== 'ENOTEMPTY'
          ) {
            failure = rollbackError;
          }
        }
      }
      if (started) {
        const reason = failureMessage(failure, download.proxyUrl);
        const failedStatus = abortController.signal.aborted ? 'canceled' : 'failed';
        const exitCode =
          typeof failure === 'object' &&
          failure !== null &&
          'exitCode' in failure &&
          Number.isSafeInteger(failure.exitCode)
            ? (failure.exitCode as number)
            : null;
        try {
          this.#database
            .prepare(
              `UPDATE downloads
               SET status = ?, failure_reason = ?, speed_text = NULL,
                   eta_seconds = NULL, exit_code = ?, finished_at = ?
               WHERE id = ? AND status = 'running'`,
            )
            .run(
              failedStatus,
              reason,
              exitCode,
              new Date().toISOString(),
              download.downloadId,
            );
        } catch (persistenceError) {
          boundaryFailure = new Error(
            failureMessage(persistenceError, download.proxyUrl),
          );
        }
      } else {
        boundaryFailure = new Error(failureMessage(failure, download.proxyUrl));
      }
    } finally {
      try {
        if (taskDirectory !== undefined) {
          await rm(taskDirectory, { recursive: true, force: true });
        }
      } catch (cleanupError) {
        const cleanupReason = failureMessage(cleanupError, download.proxyUrl);
        let cleanupPersistenceFailure: Error | undefined;
        if (started) {
          try {
            this.#database
              .prepare(
                `UPDATE downloads
                 SET status = 'failed', failure_reason = ?, finished_at = ?
                 WHERE id = ? AND status = 'failed'`,
              )
              .run(cleanupReason, new Date().toISOString(), download.downloadId);
          } catch (persistenceError) {
            const persistenceReason = failureMessage(
              persistenceError,
              download.proxyUrl,
            );
            cleanupPersistenceFailure = new Error(persistenceReason);
          }
        }
        const cleanupFailure = new Error(cleanupReason);
        if (
          boundaryFailure === undefined &&
          cleanupPersistenceFailure === undefined
        ) {
          boundaryFailure = cleanupFailure;
        } else {
          const failures = [
            ...(boundaryFailure === undefined ? [] : [boundaryFailure]),
            cleanupFailure,
            ...(cleanupPersistenceFailure === undefined
              ? []
              : [cleanupPersistenceFailure]),
          ];
          boundaryFailure = new AggregateError(
            failures,
            failures.map((failure) => failure.message).join('; '),
          );
        }
      }
      this.#activeDownloads.delete(download.downloadId);
    }

    if (boundaryFailure !== undefined) throw boundaryFailure;
  }
}
