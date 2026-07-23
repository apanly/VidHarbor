import { execFile } from 'node:child_process';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

const fsControl = vi.hoisted(() => ({
  rejectedChmodPath: undefined as string | undefined,
  rejectedLstatPath: undefined as string | undefined,
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>(
    'node:fs/promises',
  );
  const controlledChmod: typeof actual.chmod = async (path, mode) => {
    if (String(path) === fsControl.rejectedChmodPath) {
      throw Object.assign(new Error(`EACCES: cannot chmod ${String(path)}`), {
        code: 'EACCES',
      });
    }
    await actual.chmod(path, mode);
  };
  const controlledLstat: typeof actual.lstat = async (path, options) => {
    if (String(path) === fsControl.rejectedLstatPath) {
      throw Object.assign(new Error(`EACCES: cannot lstat ${String(path)}`), {
        code: 'EACCES',
      });
    }
    return await actual.lstat(path, options as never);
  };
  return { ...actual, chmod: controlledChmod, lstat: controlledLstat };
});

import type { AppConfig } from '../../src/config.js';
import { openDatabase } from '../../src/db/client.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { ChannelScheduler } from '../../src/scheduler.js';
import {
  startServer,
  type LifecycleLogRecord,
  type RunningServer,
} from '../../src/server.js';
import { YtDlpTaskManager } from '../../src/yt-dlp-task-manager.js';

const sandboxes: string[] = [];
const runningServers: RunningServer[] = [];
const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const originalPath = process.env.PATH;
const SENSITIVE_COOKIE_MARKER = 'server-lifecycle-cookie-secret';

function cookieStoragePath(config: AppConfig): string {
  return join(dirname(config.databasePath), 'cookies');
}

function permissionMode(value: number): number {
  return value & 0o777;
}

async function expectStartupFailure(
  config: AppConfig,
  message: string,
): Promise<void> {
  const result = await startServer(config, () => undefined).catch(
    (error: unknown) => error,
  );
  if ('stop' in Object(result)) {
    await (result as RunningServer).stop();
  }
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toContain(message);
}

async function createConfig(): Promise<AppConfig> {
  const sandbox = await mkdtemp(join(tmpdir(), 'vidharbor-server-lifecycle-'));
  sandboxes.push(sandbox);
  const downloadsMountPath = join(sandbox, 'downloads');
  await mkdir(downloadsMountPath);
  const binPath = join(sandbox, 'bin');
  await mkdir(binPath);
  await writeFile(
    join(binPath, 'yt-dlp'),
    '#!/bin/sh\nprintf \"2026.07.04\\n\"\n',
    'utf8',
  );
  await writeFile(
    join(binPath, 'ffmpeg'),
    '#!/bin/sh\nprintf \"ffmpeg version 5.1.9\\n\"\n',
    'utf8',
  );
  await chmod(join(binPath, 'yt-dlp'), 0o755);
  await chmod(join(binPath, 'ffmpeg'), 0o755);
  process.env.PATH = `${binPath}:${originalPath ?? ''}`;
  return {
    port: 0,
    databasePath: join(sandbox, 'vidharbor.sqlite'),
    downloadsMountPath,
  };
}

async function expectCookieInitializationFailure(
  config: AppConfig,
  sensitiveValues: readonly string[],
): Promise<void> {
  const listen = vi.spyOn(Server.prototype, 'listen');
  const records: LifecycleLogRecord[] = [];
  const failure = await startServer(config, (record) => records.push(record)).catch(
    (error: unknown) => error,
  );

  if (!(failure instanceof Error)) {
    runningServers.push(failure);
  }
  expect(
    failure instanceof Error && failure.message === 'cookie persistence failed',
  ).toBe(true);
  expect(listen).not.toHaveBeenCalled();
  expect(records.length === 0).toBe(true);

  const exposed = JSON.stringify({
    message: (failure as Error).message,
    records,
  });
  for (const sensitiveValue of sensitiveValues) {
    expect(exposed.includes(sensitiveValue)).toBe(false);
  }
}

async function stop(server: RunningServer): Promise<void> {
  const index = runningServers.indexOf(server);
  if (index !== -1) runningServers.splice(index, 1);
  await server.stop();
}

function listenerNames(server: Server, event: string): string[] {
  return server.rawListeners(event).map((listener) => {
    const wrapped = listener as typeof listener & { listener?: () => void };
    return wrapped.listener?.name ?? listener.name;
  });
}

afterEach(async () => {
  fsControl.rejectedChmodPath = undefined;
  fsControl.rejectedLstatPath = undefined;
  vi.restoreAllMocks();
  process.env.PATH = originalPath;
  await Promise.allSettled(runningServers.splice(0).map((server) => server.stop()));
  await Promise.all(
    sandboxes.splice(0).map((sandbox) =>
      rm(sandbox, { recursive: true, force: true }),
    ),
  );
});

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

describe('server lifecycle', () => {
  it('creates the Cookie storage beside the database with restricted permissions without changing lifecycle events', async () => {
    const config = await createConfig();
    const storage = cookieStoragePath(config);
    const records: LifecycleLogRecord[] = [];
    await expect(access(storage)).rejects.toMatchObject({ code: 'ENOENT' });

    const server = await startServer(config, (record) => records.push(record));
    runningServers.push(server);

    expect(permissionMode((await stat(storage)).mode)).toBe(0o700);
    expect(records.map((record) => record.event)).toEqual([
      'database_migrated',
      'downloads_recovered',
      'download_worker_started',
      'scheduler_started',
      'http_started',
    ]);
    await expect(
      access(join(config.downloadsMountPath, 'cookies')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not listen or expose sensitive data when the Cookie storage path is not a directory', async () => {
    const config = await createConfig();
    const storage = cookieStoragePath(config);
    await writeFile(storage, SENSITIVE_COOKIE_MARKER);

    await expectCookieInitializationFailure(config, [
      SENSITIVE_COOKIE_MARKER,
      storage,
    ]);
  });

  it('fails startup when yt-dlp is not executable', async () => {
    const config = await createConfig();
    const originalPath = process.env.PATH;
    process.env.PATH = join(config.downloadsMountPath, 'empty-bin');

    try {
      await expectStartupFailure(
        config,
        'yt-dlp startup check failed',
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('fails startup when ffmpeg is not executable', async () => {
    const config = await createConfig();
    const binPath = join(config.downloadsMountPath, 'bin');
    await mkdir(binPath);
    await writeFile(
      join(binPath, 'yt-dlp'),
      '#!/bin/sh\nprintf \"2026.07.04\\n\"\n',
      'utf8',
    );
    await chmod(join(binPath, 'yt-dlp'), 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = binPath;

    try {
      await expectStartupFailure(
        config,
        'ffmpeg startup check failed',
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('fails startup when the downloads mount path is unavailable', async () => {
    const config = await createConfig();
    await rm(config.downloadsMountPath, { recursive: true, force: true });

    await expectStartupFailure(
      config,
      'downloads mount path is not readable, writable, and enterable',
    );
  });

  it('starts from a clean build and serves the overview page from dist resources', async () => {
    await rm(join(projectRoot, 'dist'), { recursive: true, force: true });
    await execFileAsync('npm', ['run', 'build'], { cwd: projectRoot });

    const builtServerModule = (await import(
      `${pathToFileURL(join(projectRoot, 'dist/server.js')).href}?clean-build`
    )) as { startServer: typeof startServer };
    const config = await createConfig();
    const server = await builtServerModule.startServer(config, () => undefined);
    runningServers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('总览');
  });

  it('migrates, recovers, creates one worker and scheduler, then serves the existing overview page', async () => {
    const config = await createConfig();
    const database = openDatabase(config.databasePath);
    migrateDatabase(database);
    const interrupted = database
      .prepare(
        `INSERT INTO downloads (
          source_type, source_url, platform, platform_video_id, title,
          network_mode, status, created_at
        ) VALUES ('direct', ?, 'youtube', 'abcdefghijk', 'Interrupted',
                  'direct', 'pending', ?)`,
      )
      .run(
        'https://www.youtube.com/watch?v=abcdefghijk',
        '2026-07-17T10:00:00.000Z',
      );
    const interruptedId = Number(interrupted.lastInsertRowid);
    const temporaryDirectory = join(
      config.downloadsMountPath,
      '.vidharbor-tmp',
      String(interruptedId),
    );
    await mkdir(temporaryDirectory, { recursive: true });
    database.close();

    const records: LifecycleLogRecord[] = [];
    const server = await startServer(config, (record) => records.push(record));
    runningServers.push(server);

    expect(records.map((record) => record.event)).toEqual([
      'database_migrated',
      'downloads_recovered',
      'download_worker_started',
      'scheduler_started',
      'http_started',
    ]);
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('总览');
    await expect(readdir(temporaryDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await stop(server);
    const persisted = openDatabase(config.databasePath);
    expect(
      persisted.prepare('SELECT status FROM downloads WHERE id = ?').pluck().get(interruptedId),
    ).toBe('interrupted');
    persisted.close();
  });

  it('does not listen when interrupted download recovery fails', async () => {
    const config = await createConfig();
    const database = openDatabase(config.databasePath);
    migrateDatabase(database);
    database.exec(`
      INSERT INTO downloads (
        source_type, source_url, platform, platform_video_id, title,
        network_mode, status, created_at
      ) VALUES (
        'direct', 'https://www.youtube.com/watch?v=abcdefghijk', 'youtube',
        'abcdefghijk', 'Interrupted', 'direct', 'pending',
        '2026-07-17T10:00:00.000Z'
      );
      CREATE TRIGGER reject_recovery
      BEFORE UPDATE ON downloads
      BEGIN
        SELECT RAISE(ABORT, 'recovery rejected');
      END;
    `);
    database.close();

    const records: LifecycleLogRecord[] = [];
    await expect(startServer(config, (record) => records.push(record))).rejects.toThrow(
      'recovery rejected',
    );
    expect(records.map((record) => record.event)).toEqual(['database_migrated']);
  });

  it('cleans task directories for every known download and leaves unknown IDs', async () => {
    const config = await createConfig();
    const database = openDatabase(config.databasePath);
    migrateDatabase(database);
    database.exec(`
      INSERT INTO downloads (
        id, source_type, source_url, platform, platform_video_id, title,
        network_mode, status, failure_reason, created_at, finished_at
      ) VALUES (
        1, 'direct', 'https://www.youtube.com/watch?v=abcdefghijk', 'youtube',
        'abcdefghijk', 'Failed', 'direct', 'failed', 'fixture failure',
        '2026-07-17T10:00:00.000Z', '2026-07-17T10:01:00.000Z'
      );
      INSERT INTO downloads (
        id, source_type, source_url, platform, platform_video_id, title,
        network_mode, status, output_path, created_at, finished_at
      ) VALUES (
        2, 'direct', 'https://www.youtube.com/watch?v=lmnopqrstuv', 'youtube',
        'lmnopqrstuv', 'Completed', 'direct', 'completed', '/downloads/lmnopqrstuv.mp4',
        '2026-07-17T10:00:00.000Z', '2026-07-17T10:01:00.000Z'
      );
    `);
    database.close();
    for (const id of [1, 2, 999]) {
      await mkdir(
        join(config.downloadsMountPath, '.vidharbor-tmp', String(id)),
        { recursive: true },
      );
    }

    const server = await startServer(config, () => undefined);
    runningServers.push(server);

    await expect(
      readdir(join(config.downloadsMountPath, '.vidharbor-tmp', '1')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readdir(join(config.downloadsMountPath, '.vidharbor-tmp', '2')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readdir(join(config.downloadsMountPath, '.vidharbor-tmp', '999')),
    ).resolves.toEqual([]);
  });

  it('rejects startup cleanup when the temporary root escapes the mount', async () => {
    const config = await createConfig();
    const outsideRoot = join(config.downloadsMountPath, '..', 'outside-tmp');
    await mkdir(join(outsideRoot, '1'), { recursive: true });
    await writeFile(join(outsideRoot, '1', 'preserve.txt'), 'preserve');
    await symlink(outsideRoot, join(config.downloadsMountPath, '.vidharbor-tmp'));
    const database = openDatabase(config.databasePath);
    migrateDatabase(database);
    database.exec(`
      INSERT INTO downloads (
        id, source_type, source_url, platform, platform_video_id, title,
        network_mode, status, created_at
      ) VALUES (
        1, 'direct', 'https://www.youtube.com/watch?v=abcdefghijk', 'youtube',
        'abcdefghijk', 'Pending', 'direct', 'pending',
        '2026-07-17T10:00:00.000Z'
      );
    `);
    database.close();

    const outcome = await startServer(config, () => undefined).catch(
      (error: unknown) => error,
    );
    if (!(outcome instanceof Error)) runningServers.push(outcome);

    expect(outcome).toBeInstanceOf(Error);
    await expect(readdir(join(outsideRoot, '1'))).resolves.toEqual([
      'preserve.txt',
    ]);
  });

  it('reports each interrupted cleanup failure without exposing proxy credentials', async () => {
    const config = await createConfig();
    const database = openDatabase(config.databasePath);
    migrateDatabase(database);
    const proxyUrl = 'http://alice:secret@proxy.example:8080';
    await writeFile(
      join(config.downloadsMountPath, '.vidharbor-tmp'),
      'not a directory',
    );
    database
      .prepare(
        `INSERT INTO proxies (name, proxy_url, created_at, updated_at)
         VALUES ('office', ?, ?, ?)`,
      )
      .run(proxyUrl, '2026-07-17T10:00:00.000Z', '2026-07-17T10:00:00.000Z');
    const interrupted = database
      .prepare(
        `INSERT INTO downloads (
          source_type, source_url, platform, platform_video_id, title,
          network_mode, status, created_at
        ) VALUES ('direct', ?, 'youtube', 'abcdefghijk', 'Interrupted',
                  'direct', 'pending', ?)`,
      )
      .run(
        'https://www.youtube.com/watch?v=abcdefghijk',
        '2026-07-17T10:00:00.000Z',
      );
    const interruptedId = Number(interrupted.lastInsertRowid);
    database.close();

    const failure = await startServer(config, () => undefined).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    const message = (failure as AggregateError).message;
    expect(message).toContain(`\"downloadId\":${interruptedId}`);
    expect(message).toContain('ENOTDIR');
    expect(message).not.toContain('alice:secret');
  });

  it('removes temporary listen listeners and propagates a runtime HTTP error', async () => {
    const once = vi.spyOn(Server.prototype, 'once');
    const config = await createConfig();
    const database = openDatabase(config.databasePath);
    migrateDatabase(database);
    const proxyUrl = 'http://alice:secret@proxy.example:8080';
    database
      .prepare(
        `INSERT INTO proxies (name, proxy_url, created_at, updated_at)
         VALUES ('office', ?, ?, ?)`,
      )
      .run(proxyUrl, '2026-07-17T10:00:00.000Z', '2026-07-17T10:00:00.000Z');
    database.close();
    const server = await startServer(config, () => undefined);
    runningServers.push(server);
    const listeningCall = once.mock.calls.findIndex(([event]) => event === 'listening');
    const httpServer = once.mock.instances[listeningCall] as Server;

    expect(listenerNames(httpServer, 'listening')).not.toContain('onListening');
    expect(listenerNames(httpServer, 'error')).not.toContain('onError');
    expect(listenerNames(httpServer, 'error')).toEqual(['onRuntimeError']);

    const propagated = server.failure.catch((error: unknown) => error);
    httpServer.emit('error', new Error(`runtime HTTP failure for ${proxyUrl}`));
    const error = await propagated;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      'runtime HTTP failure for http://***@proxy.example:8080',
    );
    expect((error as Error).message).not.toContain('alice:secret');
  });

  it('removes temporary listen listeners when listening fails', async () => {
    let taskManager: YtDlpTaskManager | undefined;
    const originalManagerStop = YtDlpTaskManager.prototype.stop;
    const managerStop = vi
      .spyOn(YtDlpTaskManager.prototype, 'stop')
      .mockImplementation(function (this: YtDlpTaskManager) {
        taskManager = this;
        return originalManagerStop.call(this);
      });
    const blocker = createNetServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, resolve);
    });
    const address = blocker.address();
    if (address === null || typeof address === 'string') {
      throw new Error('blocking server has no TCP address');
    }
    const once = vi.spyOn(Server.prototype, 'once');

    try {
      const config = { ...(await createConfig()), port: address.port };
      await expect(startServer(config, () => undefined)).rejects.toMatchObject({
        code: 'EADDRINUSE',
      });
      const listeningCall = once.mock.calls.findIndex(([event]) => event === 'listening');
      const httpServer = once.mock.instances[listeningCall] as Server;
      expect(listenerNames(httpServer, 'listening')).not.toContain('onListening');
      expect(listenerNames(httpServer, 'error')).not.toContain('onError');
      expect(managerStop).toHaveBeenCalledTimes(1);
      expect(() =>
        taskManager?.submit({
          type: 'metadata_probe',
          execute: async () => undefined,
        }),
      ).toThrow('yt-dlp task manager is stopping');
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });

  it('rejects a second application instance while the first is running', async () => {
    const firstConfig = await createConfig();
    const secondConfig = await createConfig();
    const first = await startServer(firstConfig, () => undefined);
    runningServers.push(first);

    await expect(startServer(secondConfig, () => undefined)).rejects.toThrow(
      'server is already running',
    );

    await stop(first);
  });

  it('stops scheduling and HTTP before waiting for worker idle and closing the database', async () => {
    let taskManager: YtDlpTaskManager | undefined;
    const originalManagerStop = YtDlpTaskManager.prototype.stop;
    const managerStop = vi
      .spyOn(YtDlpTaskManager.prototype, 'stop')
      .mockImplementation(function (this: YtDlpTaskManager) {
        taskManager = this;
        return originalManagerStop.call(this);
      });
    const config = await createConfig();
    const records: LifecycleLogRecord[] = [];
    const server = await startServer(config, (record) => records.push(record));
    runningServers.push(server);

    const firstStop = server.stop();
    const secondStop = server.stop();
    expect(secondStop).toBe(firstStop);
    await firstStop;
    runningServers.splice(runningServers.indexOf(server), 1);

    expect(managerStop).toHaveBeenCalledTimes(1);
    expect(taskManager).toBeDefined();
    expect(() =>
      taskManager?.submit({
        type: 'metadata_probe',
        execute: async () => undefined,
      }),
    ).toThrow('yt-dlp task manager is stopping');
    expect(records.slice(-4).map((record) => record.event)).toEqual([
      'scheduler_stopped',
      'http_stopped',
      'download_worker_stopped',
      'database_closed',
    ]);
    await expect(fetch(`http://127.0.0.1:${server.port}/`)).rejects.toThrow();
  });

  it('starts task cancellation before waiting for scheduler shutdown', async () => {
    let releaseScheduler: (() => void) | undefined;
    const schedulerReleased = new Promise<void>((resolve) => {
      releaseScheduler = resolve;
    });
    const originalSchedulerStop = ChannelScheduler.prototype.stop;
    vi.spyOn(ChannelScheduler.prototype, 'stop').mockImplementation(async function () {
      await originalSchedulerStop.call(this);
      await schedulerReleased;
    });
    const managerStop = vi.spyOn(YtDlpTaskManager.prototype, 'stop');
    const config = await createConfig();
    const server = await startServer(config, () => undefined);
    runningServers.push(server);

    const stopping = server.stop();
    await vi.waitFor(() => expect(managerStop).toHaveBeenCalledTimes(1));
    releaseScheduler?.();
    await stopping;
    runningServers.splice(runningServers.indexOf(server), 1);
  });

  it('closes active download event streams during shutdown', async () => {
    const config = await createConfig();
    const server = await startServer(config, () => undefined);
    runningServers.push(server);
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/downloads/events`,
    );
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('missing SSE body');
    await reader.read();

    const result = await Promise.race([
      stop(server).then(() => 'stopped'),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('timed out'), 1_000);
      }),
    ]);

    expect(result).toBe('stopped');
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it('keeps startup download concurrency fixed, cancels running and queued downloads, and resets manager state on restart', async () => {
    const config = await createConfig();
    const database = openDatabase(config.databasePath);
    migrateDatabase(database);
    database
      .prepare('UPDATE settings SET download_concurrency = 1 WHERE id = 1')
      .run();
    database.close();

    const server = await startServer(config, () => undefined);
    runningServers.push(server);
    const changedSettings = openDatabase(config.databasePath);
    changedSettings
      .prepare('UPDATE settings SET download_concurrency = 2 WHERE id = 1')
      .run();
    changedSettings.close();

    const binPath = process.env.PATH?.split(':')[0];
    if (binPath === undefined) throw new Error('missing test bin path');
    await writeFile(
      join(binPath, 'yt-dlp'),
      `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('2026.07.04\\n');
  process.exit(0);
}
const url = args.at(-1);
const id = url.split('/').at(-1);
if (args.includes('--dump-json')) {
  process.stdout.write(JSON.stringify({
    extractor_key: 'Youtube', id, title: 'Lifecycle ' + id,
    upload_date: '20260717',
    webpage_url: 'https://www.youtube.com/watch?v=' + id,
    live_status: 'not_live'
  }) + '\\n');
  process.exit(0);
}
await writeFile(${JSON.stringify(config.downloadsMountPath)} + '/' + id + '.started', '');
setInterval(() => {}, 1000);
`,
      'utf8',
    );
    await chmod(join(binPath, 'yt-dlp'), 0o755);

    const origin = `http://127.0.0.1:${server.port}`;
    const submit = (id: string) =>
      fetch(`${origin}/api/downloads/direct`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify(directInput(`https://youtu.be/${id}`, null)),
      });
    const firstId = 'abcdefghijk';
    const secondId = 'lmnopqrstuv';
    expect((await submit(firstId)).status).toBe(202);
    expect((await submit(secondId)).status).toBe(202);

    let tasks: Array<{ id: number; type: string; status: string }> = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const snapshot = (await fetch(`${origin}/api/yt-dlp/tasks`).then((response) =>
        response.json()
      )) as { tasks: typeof tasks };
      tasks = snapshot.tasks;
      if (
        tasks.some((task) => task.type === 'media_download' && task.status === 'running') &&
        tasks.some((task) => task.type === 'media_download' && task.status === 'queued')
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(
      tasks.filter((task) => task.type === 'media_download').map((task) => task.status),
    ).toEqual(['running', 'queued']);
    await expect(access(join(config.downloadsMountPath, `${firstId}.started`))).resolves.toBeUndefined();
    await expect(access(join(config.downloadsMountPath, `${secondId}.started`))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await stop(server);
    const persisted = openDatabase(config.databasePath);
    expect(
      persisted.prepare('SELECT status FROM downloads ORDER BY id').pluck().all(),
    ).toEqual(['canceled', 'canceled']);
    persisted.close();

    const restarted = await startServer(config, () => undefined);
    runningServers.push(restarted);
    const restartedOrigin = `http://127.0.0.1:${restarted.port}`;
    await expect(
      fetch(`${restartedOrigin}/api/yt-dlp/tasks`).then((response) => response.json()),
    ).resolves.toEqual({ tasks: [] });
    const restartedResponse = await fetch(`${restartedOrigin}/api/downloads/direct`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: restartedOrigin },
      body: JSON.stringify(directInput('https://youtu.be/zyxwvutsrqp', null)),
    });
    expect(restartedResponse.status).toBe(202);
    const restartedTasks = (await fetch(`${restartedOrigin}/api/yt-dlp/tasks`).then(
      (response) => response.json(),
    )) as { tasks: Array<{ id: number }> };
    expect(restartedTasks.tasks[0]?.id).toBe(1);
    await stop(restarted);
  });

  it('cancels an accepted initial synchronization process group and finishes its database callback before close', async () => {
    const config = await createConfig();
    const database = openDatabase(config.databasePath);
    migrateDatabase(database);
    database
      .prepare('UPDATE settings SET global_check_interval_minutes = 60')
      .run();
    database.close();
    const server = await startServer(config, () => undefined);
    runningServers.push(server);

    const startedPath = join(config.downloadsMountPath, 'sync.started');
    const childPidPath = join(config.downloadsMountPath, 'sync-child.pid');
    const binPath = process.env.PATH?.split(':')[0];
    if (binPath === undefined) throw new Error('missing test bin path');
    await writeFile(
      join(binPath, 'yt-dlp'),
      `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
});
await writeFile(${JSON.stringify(childPidPath)}, String(child.pid));
await writeFile(${JSON.stringify(startedPath)}, '');
setInterval(() => {}, 1000);
`,
      'utf8',
    );
    await chmod(join(binPath, 'yt-dlp'), 0o755);
    const origin = `http://127.0.0.1:${server.port}`;
    const savedResponse = await fetch(`${origin}/api/channels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({
        url: 'https://www.youtube.com/@shutdown',
        customName: 'Shutdown channel',
        proxyId: null,
        checkIntervalMinutes: null,
      }),
    });
    const saved = (await savedResponse.json()) as { channel: { id: number } };
    const syncResponse = await fetch(
      `${origin}/api/channels/${saved.channel.id}/initial-sync`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ historyMonths: 1 }),
      },
    );
    expect(syncResponse.status).toBe(202);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await access(startedPath);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    const childPid = Number(await readFile(childPidPath, 'utf8'));
    expect(Number.isSafeInteger(childPid)).toBe(true);
    await stop(server);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        process.kill(childPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 5));
      } catch (error) {
        expect(error).toMatchObject({ code: 'ESRCH' });
        break;
      }
    }
    expect(() => process.kill(childPid, 0)).toThrow(
      expect.objectContaining({ code: 'ESRCH' }),
    );
    const persisted = openDatabase(config.databasePath);
    expect(
      persisted
        .prepare('SELECT initial_sync_status, initial_sync_error FROM channels WHERE id = ?')
        .get(saved.channel.id),
    ).toMatchObject({
      initial_sync_status: 'failed',
      initial_sync_error: expect.stringContaining('cancel'),
    });
    persisted.close();
  });

  it('propagates a redacted worker boundary failure through server shutdown', async () => {
    const config = await createConfig();
    const database = openDatabase(config.databasePath);
    migrateDatabase(database);
    const proxyUrl = 'http://alice:secret@proxy.example:8080';
    const proxy = database
      .prepare(
        `INSERT INTO proxies (name, proxy_url, created_at, updated_at)
         VALUES ('office', ?, ?, ?)`,
      )
      .run(proxyUrl, '2026-07-17T10:00:00.000Z', '2026-07-17T10:00:00.000Z');
    database.exec(`
      CREATE TRIGGER reject_worker_start
      BEFORE UPDATE OF status ON downloads
      WHEN NEW.status = 'running'
      BEGIN
        SELECT RAISE(ABORT, 'worker persistence failed for ${proxyUrl}');
      END;
    `);
    database.close();

    const executablePath = join(config.downloadsMountPath, 'yt-dlp');
    await writeFile(
      executablePath,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  extractor_key: 'Youtube',
  id: 'abcdefghijk',
  title: 'Lifecycle video',
  upload_date: '20260717',
  webpage_url: 'https://www.youtube.com/watch?v=abcdefghijk',
  live_status: 'not_live'
}) + '\\n');
`,
      'utf8',
    );
    await chmod(executablePath, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${config.downloadsMountPath}:${originalPath ?? ''}`;

    try {
      const server = await startServer(config, () => undefined);
      runningServers.push(server);
      const response = await fetch(`http://127.0.0.1:${server.port}/api/downloads/direct`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: `http://127.0.0.1:${server.port}`,
        },
        body: JSON.stringify(directInput('https://youtu.be/abcdefghijk', Number(proxy.lastInsertRowid))),
      });
      expect(response.status).toBe(202);

      const runtimeFailure = await Promise.race([
        server.failure.catch((error: unknown) => error),
        new Promise((resolve) =>
          setTimeout(() => resolve(new Error('runtime failure was not propagated')), 1_000),
        ),
      ]);
      expect(runtimeFailure).toBeInstanceOf(Error);
      expect((runtimeFailure as Error).message).toContain(
        'worker persistence failed for http://***@proxy.example:8080',
      );

      const shutdownFailure = await stop(server).catch((error: unknown) => error);
      expect(shutdownFailure).toBeInstanceOf(AggregateError);
      const workerFailure = (shutdownFailure as AggregateError).errors[0] as Error;
      expect(workerFailure.message).toContain(
        'worker persistence failed for http://***@proxy.example:8080',
      );
      expect(workerFailure.message).not.toContain('alice:secret');
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
