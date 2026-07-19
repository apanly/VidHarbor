import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { createYtDlpTasksRouter } from '../../src/routes/yt-dlp-tasks.js';
import {
  YtDlpTaskManager,
  type YtDlpTaskSnapshot,
  type YtDlpTaskType,
} from '../../src/yt-dlp-task-manager.js';

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function createManager(): YtDlpTaskManager {
  return new YtDlpTaskManager('/fixture/yt-dlp', 1, (message) =>
    message.replaceAll('alice:secret', '***:***'),
  );
}

function startServer(taskManager: YtDlpTaskManager): {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
} {
  const apiRouter = express.Router();
  apiRouter.use('/yt-dlp/tasks', createYtDlpTasksRouter(taskManager));
  const server = createApp(apiRouter).listen(0);
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/api/yt-dlp/tasks`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    }),
  };
}

async function schedulingTurn(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const servers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((close) => close()));
});

describe('GET /api/yt-dlp/tasks', () => {
  it('returns the manager snapshot with all fixed types, statuses, and terminal states', async () => {
    const manager = createManager();
    const runningGate = deferred();
    const queuedGate = deferred();

    const running = manager.submit({
      type: 'media_download',
      execute: () => runningGate.promise,
    });
    const queued = manager.submit({
      type: 'media_download',
      execute: () => queuedGate.promise,
    });
    const succeeded = manager.submit({
      type: 'metadata_probe',
      execute: async () => 'business result must not be exposed',
    });
    const failed = manager.submit({
      type: 'channel_initial_sync',
      execute: async () => {
        throw new Error(
          'request failed via http://alice:secret@proxy.example:8080',
        );
      },
    });
    void failed.result.catch(() => undefined);
    const canceled = manager.submit({
      type: 'channel_manual_check',
      execute: async () => undefined,
    });
    void canceled.result.catch(() => undefined);
    await manager.cancel(canceled.id);
    const scheduled = manager.submit({
      type: 'channel_scheduled_check',
      execute: async () => undefined,
    });

    await Promise.all([succeeded.result, failed.result.catch(() => undefined), scheduled.result]);
    await schedulingTurn();

    const server = startServer(manager);
    servers.push(server.close);
    const response = await fetch(server.baseUrl);
    const body = await response.json() as { tasks: YtDlpTaskSnapshot[] };

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(body.tasks.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(body.tasks.map(({ type }) => type))).toEqual(
      new Set<YtDlpTaskType>([
        'media_download',
        'metadata_probe',
        'channel_initial_sync',
        'channel_manual_check',
        'channel_scheduled_check',
      ]),
    );
    expect(new Set(body.tasks.map(({ status }) => status))).toEqual(
      new Set(['queued', 'running', 'succeeded', 'failed', 'canceled']),
    );
    expect(body.tasks.map(({ status }) => status)).toEqual([
      'running',
      'queued',
      'succeeded',
      'failed',
      'canceled',
      'succeeded',
    ]);

    for (const task of body.tasks) {
      expect(Object.keys(task)).toEqual([
        'id',
        'type',
        'status',
        'createdAt',
        'startedAt',
        'finishedAt',
        'failureReason',
      ]);
      expect(task.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(task).not.toHaveProperty('payload');
      expect(task).not.toHaveProperty('url');
      expect(task).not.toHaveProperty('proxy');
      expect(task).not.toHaveProperty('arguments');
      expect(task).not.toHaveProperty('result');
      expect(task).not.toHaveProperty('controller');
      expect(task).not.toHaveProperty('process');
    }

    expect(body.tasks[0]).toMatchObject({
      startedAt: expect.any(String),
      finishedAt: null,
      failureReason: null,
    });
    expect(body.tasks[1]).toMatchObject({
      startedAt: null,
      finishedAt: null,
      failureReason: null,
    });
    expect(body.tasks[2]).toMatchObject({
      startedAt: expect.any(String),
      finishedAt: expect.any(String),
      failureReason: null,
    });
    expect(body.tasks[3]).toMatchObject({
      startedAt: expect.any(String),
      finishedAt: expect.any(String),
      failureReason:
        'request failed via http://***:***@proxy.example:8080',
    });
    expect(body.tasks[4]).toMatchObject({
      startedAt: null,
      finishedAt: expect.any(String),
      failureReason: null,
    });
    expect(JSON.stringify(body)).not.toContain('alice:secret');
    expect(JSON.stringify(body)).not.toContain('business result must not be exposed');

    runningGate.resolve();
    queuedGate.resolve();
    await Promise.all([running.result, queued.result]);
  });

  it.each([
    { method: 'POST', path: '' },
    { method: 'PUT', path: '' },
    { method: 'PATCH', path: '' },
    { method: 'DELETE', path: '' },
    { method: 'POST', path: '/1/retry' },
    { method: 'POST', path: '/1/cancel' },
  ])(
    'does not provide $method $path',
    async ({ method, path }) => {
      const manager = createManager();
      const server = startServer(manager);
      servers.push(server.close);

      const response = await fetch(`${server.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          origin: new URL(server.baseUrl).origin,
        },
        body: method === 'DELETE' ? undefined : '{}',
      });

      expect(response.status).toBe(404);
    },
  );

  it('uses the global internal-error response for unexpected snapshot failures', async () => {
    const manager = {
      getSnapshot(): readonly YtDlpTaskSnapshot[] {
        throw new Error('snapshot failed');
      },
    } as YtDlpTaskManager;
    const server = startServer(manager);
    servers.push(server.close);

    const response = await fetch(server.baseUrl);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'PERSISTENCE_ERROR',
        message: 'internal server error',
      },
    });
  });
});
