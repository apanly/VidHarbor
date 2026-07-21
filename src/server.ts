import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { access, constants, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { createApiRouter, createApp } from './app.js';
import { loadConfig, type AppConfig } from './config.js';
import { openDatabase, type DatabaseConnection } from './db/client.js';
import { migrateDatabase } from './db/migrate.js';
import {
  cleanupInterruptedDownloadDirectories,
  DownloadWorker,
  listDownloadIds,
  listInterruptedDownloadIds,
  recoverInterruptedDownloads,
} from './download-worker.js';
import { redactStderr } from './redaction.js';
import { validateDownloadRoot } from './filesystem.js';
import { ChannelScheduler } from './scheduler.js';
import { RuntimeCoordinator } from './runtime.js';
import {
  checkScheduledChannel,
  recoverInterruptedChannelSyncs,
} from './services/channel.js';
import { CookieAuthorizationService } from './services/cookie-authorization.js';
import { YtDlpTaskManager } from './yt-dlp-task-manager.js';

export type LifecycleEvent =
  | 'database_migrated'
  | 'downloads_recovered'
  | 'download_worker_started'
  | 'scheduler_started'
  | 'http_started'
  | 'scheduler_stopped'
  | 'http_stopped'
  | 'download_worker_stopped'
  | 'database_closed';

export interface LifecycleLogRecord {
  readonly event: LifecycleEvent;
}

export type LifecycleLogger = (record: LifecycleLogRecord) => void;

export interface RunningServer {
  readonly port: number;
  readonly failure: Promise<never>;
  stop(): Promise<void>;
}

let activeServer = false;
const execFileAsync = promisify(execFile);

function defaultLogger(record: LifecycleLogRecord): void {
  console.log(JSON.stringify(record));
}

function loadConfiguredDownloadRoot(
  database: DatabaseConnection,
  downloadsMountPath: string,
): string {
  const downloadRoot = database
    .prepare('SELECT download_root FROM settings WHERE id = 1')
    .pluck()
    .get();
  if (downloadRoot !== null && typeof downloadRoot !== 'string') {
    throw new Error('settings download root is invalid');
  }
  return downloadRoot ?? downloadsMountPath;
}

function loadDownloadConcurrency(database: DatabaseConnection): number {
  const downloadConcurrency = database
    .prepare('SELECT download_concurrency FROM settings WHERE id = 1')
    .pluck()
    .get();
  if (
    typeof downloadConcurrency !== 'number' ||
    !Number.isSafeInteger(downloadConcurrency) ||
    downloadConcurrency < 1
  ) {
    throw new Error('settings download concurrency is invalid');
  }
  return downloadConcurrency;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.removeListener('listening', onListening);
      server.removeListener('error', onError);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    server.once('listening', onListening);
    server.once('error', onError);
  });
}

function loadProxyUrls(database: DatabaseConnection): string[] {
  return database.prepare('SELECT proxy_url FROM proxies').pluck().all() as string[];
}

function redactedErrorMessage(
  error: unknown,
  proxyUrls: readonly string[],
): string {
  return redactStderr(
    error instanceof Error ? error.message : 'unknown error',
    proxyUrls,
  );
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

async function assertExecutableAvailable(
  executable: 'yt-dlp' | 'ffmpeg',
  args: readonly string[],
): Promise<void> {
  try {
    await execFileAsync(executable, [...args]);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`${executable} startup check failed: ${message}`);
  }
}

async function assertDownloadsMountAvailable(downloadsMountPath: string): Promise<void> {
  try {
    const pathStat = await stat(downloadsMountPath);
    if (!pathStat.isDirectory()) {
      throw new Error('path is not a directory');
    }
    await access(downloadsMountPath, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new Error(
      `downloads mount path is not readable, writable, and enterable: ${message}`,
    );
  }
}

async function assertStartupDependencies(config: AppConfig): Promise<void> {
  await assertDownloadsMountAvailable(config.downloadsMountPath);
  await assertExecutableAvailable('yt-dlp', ['--version']);
  await assertExecutableAvailable('ffmpeg', ['-version']);
}

function throwWithCleanupErrors(
  primaryError: unknown,
  cleanupErrors: readonly unknown[],
): never {
  if (cleanupErrors.length === 0) throw primaryError;
  throw new AggregateError(
    [primaryError, ...cleanupErrors],
    'server lifecycle failed and cleanup also failed',
  );
}

export async function startServer(
  config: AppConfig = loadConfig(),
  log: LifecycleLogger = defaultLogger,
): Promise<RunningServer> {
  if (activeServer) throw new Error('server is already running');
  activeServer = true;

  let database: DatabaseConnection | undefined;
  let taskManager: YtDlpTaskManager | undefined;
  let worker: DownloadWorker | undefined;
  let scheduler: ChannelScheduler | undefined;
  let runtime: RuntimeCoordinator | undefined;
  let httpServer: Server | undefined;

  try {
    await assertStartupDependencies(config);
    const cookieAuthorizationService = new CookieAuthorizationService(
      join(dirname(config.databasePath), 'cookies'),
    );
    await cookieAuthorizationService.initialize();
    database = openDatabase(config.databasePath);
    migrateDatabase(database);
    log({ event: 'database_migrated' });
    recoverInterruptedChannelSyncs(database);
    const proxyUrls = loadProxyUrls(database);
    let rejectRuntimeFailure!: (error: Error) => void;
    const failure = new Promise<never>((_resolve, reject) => {
      rejectRuntimeFailure = reject;
    });
    void failure.catch(() => undefined);
    const reportRuntimeFailure = (error: unknown) => {
      rejectRuntimeFailure(new Error(redactedErrorMessage(error, proxyUrls)));
    };
    runtime = new RuntimeCoordinator(reportRuntimeFailure);

    const interruptedIds = listInterruptedDownloadIds(database);
    const cleanupIds = listDownloadIds(database);
    if (cleanupIds.length > 0) {
      const downloadRoot = loadConfiguredDownloadRoot(database, config.downloadsMountPath);
      const realDownloadRoot = await validateDownloadRoot(
        downloadRoot,
        config.downloadsMountPath,
      );
      const cleanupFailures = await cleanupInterruptedDownloadDirectories(
        realDownloadRoot,
        cleanupIds,
      );
      if (cleanupFailures.length > 0) {
        const failureRecords = cleanupFailures.map((failure) => ({
          downloadId: failure.downloadId,
          reason: redactedErrorMessage(failure.error, proxyUrls),
        }));
        throw new AggregateError(
          failureRecords.map((failure) => new Error(JSON.stringify(failure))),
          `interrupted download cleanup failed: ${JSON.stringify(failureRecords)}`,
        );
      }
    }
    recoverInterruptedDownloads(database, interruptedIds, new Date().toISOString());
    log({ event: 'downloads_recovered' });

    const downloadConcurrency = loadDownloadConcurrency(database);
    const manager = new YtDlpTaskManager(
      'yt-dlp',
      downloadConcurrency,
      (message) => redactStderr(message, proxyUrls),
    );
    taskManager = manager;
    worker = new DownloadWorker(database, manager);
    void worker.failure.catch(reportRuntimeFailure);
    log({ event: 'download_worker_started' });

    scheduler = new ChannelScheduler(database, (channelId, startedAt) =>
      checkScheduledChannel(
        database as DatabaseConnection,
        manager,
        channelId,
        startedAt,
      ),
      undefined,
      reportRuntimeFailure,
    );
    scheduler.start();
    log({ event: 'scheduler_started' });

    const app = createApp(
      createApiRouter(
        database,
        config.downloadsMountPath,
        runtime,
        manager,
        worker,
        cookieAuthorizationService,
      ),
    );
    httpServer = app.listen(config.port);
    await listen(httpServer);
    const address = httpServer.address() as AddressInfo | null;
    if (address === null) throw new Error('HTTP server has no listening address');

    const onRuntimeError = (error: Error) => {
      reportRuntimeFailure(error);
    };
    httpServer.once('error', onRuntimeError);
    log({ event: 'http_started' });

    let stopping: Promise<void> | undefined;
    const runningServer: RunningServer = {
      port: address.port,
      failure,
      stop: () => {
        if (stopping !== undefined) return stopping;
        stopping = (async () => {
          const shutdownErrors: unknown[] = [];

          httpServer?.removeListener('error', onRuntimeError);

          const schedulerBoundary = scheduler?.stop().catch((error: unknown) => {
            shutdownErrors.push(error);
          });
          const taskManagerBoundary = taskManager?.stop().catch((error: unknown) => {
            shutdownErrors.push(error);
          });
          log({ event: 'scheduler_stopped' });
          runtime?.closeDownloadEventStreams();

          try {
            await close(httpServer as Server);
            log({ event: 'http_stopped' });
          } catch (error) {
            shutdownErrors.push(error);
          }

          await schedulerBoundary;
          await taskManagerBoundary;
          await worker?.waitForIdle().catch((error: unknown) => {
            shutdownErrors.push(error);
          });
          log({ event: 'download_worker_stopped' });

          try {
            database?.close();
            log({ event: 'database_closed' });
          } catch (error) {
            shutdownErrors.push(error);
          } finally {
            activeServer = false;
          }

          if (shutdownErrors.length > 0) {
            throw new AggregateError(shutdownErrors, 'server shutdown failed');
          }
        })();
        return stopping;
      },
    };
    return runningServer;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    const schedulerBoundary = scheduler?.stop().catch((cleanupError: unknown) => {
      cleanupErrors.push(cleanupError);
    });
    const taskManagerBoundary = taskManager?.stop().catch((cleanupError: unknown) => {
      cleanupErrors.push(cleanupError);
    });
    if (httpServer?.listening === true) {
      try {
        await close(httpServer);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    await schedulerBoundary;
    await taskManagerBoundary;
    if (worker !== undefined) {
      try {
        await worker.waitForIdle();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (database !== undefined) {
      try {
        database.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    activeServer = false;
    throwWithCleanupErrors(error, cleanupErrors);
  }
}

async function main(): Promise<void> {
  try {
    const server = await startServer();
    void server.failure.catch(async (error: Error) => {
      console.error(
        JSON.stringify({
          event: 'runtime_failed',
          error: error.message,
        }),
      );
      process.exitCode = 1;
      try {
        await server.stop();
      } catch (shutdownError) {
        console.error(
          JSON.stringify({
            event: 'shutdown_failed',
            error:
              shutdownError instanceof Error
                ? shutdownError.message
                : 'unknown error',
          }),
        );
      }
    });
    const shutdown = (signal: 'SIGTERM' | 'SIGINT') => {
      void server.stop().catch((error: unknown) => {
        console.error(
          JSON.stringify({
            event: 'shutdown_failed',
            signal,
            error: error instanceof Error ? error.message : 'unknown error',
          }),
        );
        process.exitCode = 1;
      });
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'startup_failed',
        error: error instanceof Error ? error.message : 'unknown error',
      }),
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main();
}
