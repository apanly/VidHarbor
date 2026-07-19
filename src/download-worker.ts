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
import { formatFailureReason } from './redaction.js';
import type {
  DownloadQueue,
  QueuedDownload,
} from './services/download.js';
import {
  isYtDlpTaskCancellationError,
  YtDlpTaskCancellationError,
} from './yt-dlp-task-cancellation.js';
import {
  type YtDlpOperations,
  type YtDlpTaskManager,
} from './yt-dlp-task-manager.js';

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
  return formatFailureReason(message, proxyUrl === undefined ? [] : [proxyUrl]);
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
): Promise<{
  readonly mainFilename: string;
  readonly mainSizeBytes: number;
  readonly filenames: readonly string[];
}> {
  if (!isAbsolute(reportedPath)) {
    throw new Error('after_move filepath must be absolute');
  }

  const realReportedPath = await realpath(resolve(reportedPath));
  if (!isContained(taskDirectory, realReportedPath) || realReportedPath === taskDirectory) {
    throw new Error('after_move filepath is outside the task directory');
  }
  const entries = await readdir(taskDirectory, { withFileTypes: true });
  if (entries.length === 0) throw new Error('task directory contains no files');
  let mainSizeBytes: number | undefined;
  for (const entry of entries) {
    if (!entry.isFile()) throw new Error('task directory contains a non-file entry');
    const path = resolve(taskDirectory, entry.name);
    const realPath = await realpath(path);
    const fileStat = await stat(realPath);
    if (!isContained(taskDirectory, realPath) || !fileStat.isFile() || fileStat.size === 0) {
      throw new Error('downloaded artifacts must be non-empty regular files');
    }
    if (realPath === realReportedPath) mainSizeBytes = fileStat.size;
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
  if (mainSizeBytes === undefined) throw new Error('downloaded main file is missing');
  return { mainFilename, mainSizeBytes, filenames: entries.map((entry) => entry.name) };
}

async function tryDownloadThumbnail(
  operations: YtDlpOperations,
  taskDirectory: string,
  download: QueuedDownload,
): Promise<string | undefined> {
  const thumbnailDirectory = join(taskDirectory, '.thumbnail');
  try {
    await mkdir(thumbnailDirectory);
    await operations.downloadThumbnail({
      url: download.sourceUrl,
      outputTemplate: join(thumbnailDirectory, '%(id)s.%(ext)s'),
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
  } catch (error) {
    if (
      isYtDlpTaskCancellationError(error) ||
      operations.signal.aborted
    ) {
      throw error;
    }
    return undefined;
  } finally {
    await rm(thumbnailDirectory, { recursive: true, force: true });
  }
}

function cancellationError(): YtDlpTaskCancellationError {
  return new YtDlpTaskCancellationError();
}

class DownloadWorkerBoundaryError extends Error {
  constructor(error: Error) {
    super(error.message, { cause: error });
    this.name = 'DownloadWorkerBoundaryError';
  }
}

export class DownloadWorker implements DownloadQueue {
  readonly failure: Promise<never>;
  readonly #database: DatabaseConnection;
  readonly #taskManager: YtDlpTaskManager;
  readonly #taskIds = new Map<number, number>();
  readonly #idleWaiters: Array<{
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
  }> = [];
  #failure: Error | undefined;
  #rejectFailure!: (error: Error) => void;

  constructor(database: DatabaseConnection, taskManager: YtDlpTaskManager) {
    this.#database = database;
    this.#taskManager = taskManager;
    this.failure = new Promise<never>((_resolve, reject) => {
      this.#rejectFailure = reject;
    });
    void this.failure.catch(() => undefined);
  }

  enqueue(download: QueuedDownload): void {
    if (this.#failure !== undefined) throw this.#failure;
    const handle = this.#taskManager.submit({
      type: 'media_download',
      execute: (operations) => this.#run(download, operations),
    });
    this.#taskIds.set(download.downloadId, handle.id);
    void handle.result.then(
      () => this.#finishTrackedTask(download.downloadId, handle.id),
      (error: unknown) => {
        if (error instanceof DownloadWorkerBoundaryError) {
          this.#reportFailure(error);
        }
        this.#finishTrackedTask(download.downloadId, handle.id);
      },
    );
  }

  async cancel(downloadId: number): Promise<void> {
    const taskId = this.#taskIds.get(downloadId);
    if (taskId === undefined) return;
    await this.#taskManager.cancel(taskId);
  }

  waitForIdle(): Promise<void> {
    if (this.#failure !== undefined) {
      return Promise.reject(this.#failure);
    }
    if (this.#taskIds.size === 0) {
      return Promise.resolve();
    }
    return new Promise((resolvePromise, rejectPromise) => {
      this.#idleWaiters.push({ resolve: resolvePromise, reject: rejectPromise });
    });
  }

  #reportFailure(
    error: DownloadWorkerBoundaryError,
    currentTaskId?: number,
  ): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    this.#rejectFailure(error);
    for (const taskId of this.#taskIds.values()) {
      if (taskId !== currentTaskId) void this.#taskManager.cancel(taskId);
    }
  }

  #finishTrackedTask(downloadId: number, taskId: number): void {
    if (this.#taskIds.get(downloadId) === taskId) {
      this.#taskIds.delete(downloadId);
    }
    if (this.#taskIds.size === 0) this.#settleIdleWaiters();
  }

  #settleIdleWaiters(): void {
    for (const waiter of this.#idleWaiters.splice(0)) {
      if (this.#failure === undefined) waiter.resolve();
      else waiter.reject(this.#failure);
    }
  }

  async #run(
    download: QueuedDownload,
    operations: YtDlpOperations,
  ): Promise<void> {
    let taskDirectory: string | undefined;
    let started = false;
    let archivedDirectory: string | undefined;
    const archivedFiles: string[] = [];
    let preCompletionCleanupFailure: Error | undefined;
    let boundaryFailure: Error | undefined;
    let taskFailure: unknown;

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
      const reportedPath = await operations.downloadMedia({
        url: download.sourceUrl,
        outputTemplate: join(taskDirectory, '%(id)s.%(ext)s'),
        onProgress: persistProgress,
        ...(download.advancedOptions === undefined
          ? {}
          : { advancedOptions: download.advancedOptions }),
        ...(download.proxyUrl === undefined
          ? {}
          : { proxyUrl: download.proxyUrl }),
      });
      let thumbnailFilename: string | undefined;
      try {
        thumbnailFilename = await tryDownloadThumbnail(
          operations,
          taskDirectory,
          download,
        );
      } catch (error) {
        if (!isYtDlpTaskCancellationError(error)) {
          boundaryFailure = new Error(failureMessage(error, download.proxyUrl));
        }
        throw error;
      }
      this.#throwIfCanceled(operations.signal);
      const downloadedFiles = await validateDownloadedFiles(
        taskDirectory,
        reportedPath,
      );
      this.#throwIfCanceled(operations.signal);
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
        this.#throwIfCanceled(operations.signal);
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
        this.#throwIfCanceled(operations.signal);
      }
      const targetPath = join(targetDirectory, downloadedFiles.mainFilename);
      const thumbnailPath = thumbnailFilename === undefined
        ? null
        : join(targetDirectory, thumbnailFilename);

      try {
        await rm(taskDirectory, { recursive: true, force: true });
      } catch (cleanupError) {
        preCompletionCleanupFailure = new Error(
          failureMessage(cleanupError, download.proxyUrl),
        );
        throw cleanupError;
      }
      taskDirectory = undefined;
      this.#throwIfCanceled(operations.signal);
      const completeDownload = this.#database.prepare(
        `UPDATE downloads
         SET status = 'completed', output_path = ?, thumbnail_path = ?,
             output_size_bytes = ?,
             progress_percent = 100,
             speed_text = NULL, eta_seconds = NULL, exit_code = 0,
             finished_at = ?
         WHERE id = ? AND status = 'running'`,
      );
      this.#throwIfCanceled(operations.signal);
      const completed = completeDownload.run(
          targetPath,
          thumbnailPath,
          downloadedFiles.mainSizeBytes,
          new Date().toISOString(),
          download.downloadId,
        );
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
            boundaryFailure = new Error(
              failureMessage(rollbackError, download.proxyUrl),
            );
          }
        }
      }
      if (started) {
        const reason = failureMessage(failure, download.proxyUrl);
        const failedStatus = isYtDlpTaskCancellationError(failure)
          ? 'canceled'
          : 'failed';
        if (
          failedStatus === 'failed' &&
          operations.signal.aborted &&
          boundaryFailure === undefined
        ) {
          boundaryFailure = new Error(reason);
        }
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
        taskFailure = failure;
      } else {
        boundaryFailure = new Error(failureMessage(failure, download.proxyUrl));
      }
    } finally {
      try {
        if (
          taskDirectory !== undefined &&
          preCompletionCleanupFailure === undefined
        ) {
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
                 WHERE id = ? AND status IN ('failed', 'canceled')`,
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
    }

    if (preCompletionCleanupFailure !== undefined) {
      if (boundaryFailure === undefined) {
        boundaryFailure = preCompletionCleanupFailure;
      } else {
        boundaryFailure = new AggregateError(
          [boundaryFailure, preCompletionCleanupFailure],
          `${boundaryFailure.message}; ${preCompletionCleanupFailure.message}`,
        );
      }
    }

    if (boundaryFailure !== undefined) {
      const workerFailure = new DownloadWorkerBoundaryError(boundaryFailure);
      this.#reportFailure(
        workerFailure,
        this.#taskIds.get(download.downloadId),
      );
      throw workerFailure;
    }
    if (taskFailure !== undefined) throw taskFailure;
  }

  #throwIfCanceled(signal: AbortSignal): void {
    if (signal.aborted) throw cancellationError();
  }
}
