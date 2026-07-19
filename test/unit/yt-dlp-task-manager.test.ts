import { describe, expect, it, vi } from 'vitest';

const ytDlp = vi.hoisted(() => ({
  downloadMedia: vi.fn(),
  downloadThumbnail: vi.fn(),
  fetchChannelEntries: vi.fn(),
  fetchVideoMetadata: vi.fn(),
}));

vi.mock('../../src/yt-dlp.js', () => ytDlp);

import {
  YT_DLP_TASK_TYPES,
  YtDlpTaskCancellationError,
  YtDlpTaskManager,
  type YtDlpTaskSubmission,
  type YtDlpTaskType,
} from '../../src/yt-dlp-task-manager.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function createManager(downloadConcurrency = 1): YtDlpTaskManager {
  return new YtDlpTaskManager(
    '/fixture/yt-dlp',
    downloadConcurrency,
    (message) => message.replaceAll('secret', '***'),
  );
}

async function schedulingTurn(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('YtDlpTaskManager', () => {
  it('rejects invalid constructor inputs', () => {
    expect(() => new YtDlpTaskManager('', 1, String)).toThrow(
      'yt-dlp executable path must be a non-empty string',
    );
    expect(() => new YtDlpTaskManager('/yt-dlp', 0, String)).toThrow(
      'download concurrency must be a positive integer',
    );
    expect(() => new YtDlpTaskManager('/yt-dlp', 1.5, String)).toThrow(
      'download concurrency must be a positive integer',
    );
    expect(
      () =>
        new YtDlpTaskManager(
          '/yt-dlp',
          1,
          undefined as unknown as (message: string) => string,
        ),
    ).toThrow('redact failure reason must be a function');
  });

  it('accepts exactly the five task types and assigns increasing IDs', async () => {
    const manager = createManager(5);
    const handles = YT_DLP_TASK_TYPES.map((type, index) =>
      manager.submit({
        type,
        execute: async () => `result-${String(index)}`,
      }),
    );

    expect(handles.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5]);
    expect(manager.getSnapshot().map(({ status }) => status)).toEqual([
      'queued',
      'queued',
      'queued',
      'queued',
      'queued',
    ]);
    await expect(Promise.all(handles.map(({ result }) => result))).resolves.toEqual(
      ['result-0', 'result-1', 'result-2', 'result-3', 'result-4'],
    );

    const snapshots = manager.getSnapshot();
    expect(snapshots.map(({ type }) => type)).toEqual(YT_DLP_TASK_TYPES);
    expect(snapshots.map(({ status }) => status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
    for (const snapshot of snapshots) {
      expect(Object.keys(snapshot)).toEqual([
        'id',
        'type',
        'status',
        'createdAt',
        'startedAt',
        'finishedAt',
        'failureReason',
      ]);
      expect(snapshot.startedAt).not.toBeNull();
      expect(snapshot.finishedAt).not.toBeNull();
      expect(snapshot.failureReason).toBeNull();
    }
  });

  it('runs media downloads FIFO within the fixed download concurrency', async () => {
    const manager = createManager(2);
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const started: number[] = [];
    const handles = gates.map((gate, index) =>
      manager.submit({
        type: 'media_download',
        execute: async () => {
          started.push(index + 1);
          await gate.promise;
          return index + 1;
        },
      }),
    );

    await schedulingTurn();
    expect(started).toEqual([1, 2]);
    expect(manager.getSnapshot().map(({ status }) => status)).toEqual([
      'running',
      'running',
      'queued',
    ]);

    gates[1]?.resolve();
    await handles[1]?.result;
    await schedulingTurn();
    expect(started).toEqual([1, 2, 3]);
    expect(manager.getSnapshot().map(({ status }) => status)).toEqual([
      'running',
      'succeeded',
      'running',
    ]);

    gates[0]?.resolve();
    gates[2]?.resolve();
    await expect(Promise.all(handles.map(({ result }) => result))).resolves.toEqual([
      1, 2, 3,
    ]);
  });

  it.each<YtDlpTaskType>([
    'metadata_probe',
    'channel_initial_sync',
    'channel_manual_check',
    'channel_scheduled_check',
  ])('runs %s without consuming a download slot', async (type) => {
    const manager = createManager();
    const downloadGate = deferred<void>();
    const queuedDownloadGate = deferred<void>();
    const firstDownload = manager.submit({
      type: 'media_download',
      execute: () => downloadGate.promise,
    });
    const secondDownload = manager.submit({
      type: 'media_download',
      execute: () => queuedDownloadGate.promise,
    });
    const independentTask = manager.submit({
      type,
      execute: async () => 'independent',
    });

    await expect(independentTask.result).resolves.toBe('independent');
    expect(manager.getSnapshot().map(({ status }) => status)).toEqual([
      'running',
      'queued',
      'succeeded',
    ]);

    downloadGate.resolve();
    queuedDownloadGate.resolve();
    await Promise.all([firstDownload.result, secondDownload.result]);
  });

  it('binds the executable path and one task signal to all operations', async () => {
    ytDlp.fetchChannelEntries.mockResolvedValueOnce([]);
    ytDlp.fetchVideoMetadata.mockResolvedValueOnce({ id: 'video' });
    ytDlp.downloadMedia.mockResolvedValueOnce('/output/video.mp4');
    ytDlp.downloadThumbnail.mockResolvedValueOnce(undefined);
    const manager = createManager();
    let taskSignal: AbortSignal | undefined;
    const handle = manager.submit({
      type: 'metadata_probe',
      execute: async (operations) => {
        taskSignal = operations.signal;
        await operations.fetchChannelEntries({ url: 'channel' });
        await operations.fetchVideoMetadata({ url: 'video' });
        await operations.downloadMedia({ url: 'video', outputTemplate: 'media' });
        await operations.downloadThumbnail({
          url: 'thumbnail',
          outputTemplate: 'thumb',
        });
      },
    });

    await handle.result;
    const calls = [
      ytDlp.fetchChannelEntries.mock.calls[0]?.[0],
      ytDlp.fetchVideoMetadata.mock.calls[0]?.[0],
      ytDlp.downloadMedia.mock.calls[0]?.[0],
      ytDlp.downloadThumbnail.mock.calls[0]?.[0],
    ];
    expect(calls.map((options) => options.executablePath)).toEqual([
      '/fixture/yt-dlp',
      '/fixture/yt-dlp',
      '/fixture/yt-dlp',
      '/fixture/yt-dlp',
    ]);
    expect(new Set(calls.map((options) => options.signal)).size).toBe(1);
    expect(calls.every((options) => options.signal === taskSignal)).toBe(true);
  });

  it('records a redacted failure and cannot rewrite the terminal state', async () => {
    const manager = createManager();
    const failure = new Error('request used secret credentials');
    const handle = manager.submit({
      type: 'metadata_probe',
      execute: async () => {
        throw failure;
      },
    });

    await expect(handle.result).rejects.toBe(failure);
    expect(manager.getSnapshot()[0]).toMatchObject({
      status: 'failed',
      failureReason: 'request used *** credentials',
    });
    await manager.cancel(handle.id);
    expect(manager.getSnapshot()[0]).toMatchObject({
      status: 'failed',
      failureReason: 'request used *** credentials',
    });
  });

  it.each(['priority', 'pool', 'weight', 'dedupe', 'retry'])(
    'rejects the undefined %s scheduling field',
    (field) => {
      const manager = createManager();
      const submission = {
        type: 'media_download',
        execute: async () => undefined,
        [field]: true,
      } as unknown as YtDlpTaskSubmission<void>;

      expect(() => manager.submit(submission)).toThrow(
        `unsupported yt-dlp task field: ${field}`,
      );
      expect(manager.getSnapshot()).toEqual([]);
    },
  );

  it('rejects unknown types, missing executors, and unrelated extra fields', () => {
    const manager = createManager();
    expect(() =>
      manager.submit({
        type: 'unknown',
        execute: async () => undefined,
      } as unknown as YtDlpTaskSubmission<void>),
    ).toThrow('unsupported yt-dlp task type: unknown');
    expect(() =>
      manager.submit({
        type: 'metadata_probe',
      } as unknown as YtDlpTaskSubmission<void>),
    ).toThrow('yt-dlp task submission requires type and execute');
    expect(() =>
      manager.submit({
        type: 'metadata_probe',
        execute: async () => undefined,
        payload: { url: 'secret' },
      } as unknown as YtDlpTaskSubmission<void>),
    ).toThrow('unsupported yt-dlp task field: payload');
    expect(manager.getSnapshot()).toEqual([]);
  });

  it('cancels a queued download without invoking its executor', async () => {
    const manager = createManager();
    const runningGate = deferred<void>();
    const running = manager.submit({
      type: 'media_download',
      execute: () => runningGate.promise,
    });
    const queuedExecute = vi.fn(async () => undefined);
    const queued = manager.submit({
      type: 'media_download',
      execute: queuedExecute,
    });
    const queuedResult = queued.result.catch((error: unknown) => error);
    await schedulingTurn();

    await manager.cancel(queued.id);
    expect(await queuedResult).toEqual(new Error('yt-dlp task canceled'));
    expect(queuedExecute).not.toHaveBeenCalled();
    expect(manager.getSnapshot()[1]).toMatchObject({
      status: 'canceled',
      startedAt: null,
      failureReason: null,
    });

    runningGate.resolve();
    await running.result;
  });

  it('aborts a running operation and waits for its executor to settle', async () => {
    const cleanup = deferred<void>();
    let observedAbort = false;
    ytDlp.fetchVideoMetadata.mockImplementationOnce(
      (options: { readonly signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => {
              observedAbort = true;
              void cleanup.promise.then(() => reject(options.signal.reason));
            },
            { once: true },
          );
        }),
    );
    const manager = createManager();
    const handle = manager.submit({
      type: 'metadata_probe',
      execute: (operations) => operations.fetchVideoMetadata({ url: 'video' }),
    });
    const result = handle.result.catch((error: unknown) => error);
    await schedulingTurn();

    let cancelSettled = false;
    const cancel = manager.cancel(handle.id).then(() => {
      cancelSettled = true;
    });
    await schedulingTurn();
    expect(observedAbort).toBe(true);
    expect(cancelSettled).toBe(false);
    expect(manager.getSnapshot()[0]?.status).toBe('running');

    cleanup.resolve();
    await cancel;
    expect(await result).toEqual(new Error('yt-dlp task canceled'));
    expect(manager.getSnapshot()[0]).toMatchObject({
      status: 'canceled',
      failureReason: null,
    });
  });

  it('preserves an explicitly typed cancellation rejection', async () => {
    const manager = createManager();
    const cancellation = new YtDlpTaskCancellationError();
    const handle = manager.submit({
      type: 'metadata_probe',
      execute: async () => {
        throw cancellation;
      },
    });

    await expect(handle.result).rejects.toBe(cancellation);
    expect(manager.getSnapshot()[0]).toMatchObject({
      status: 'canceled',
      failureReason: null,
    });
  });

  it('preserves an unknown executor failure after cancellation', async () => {
    const execution = deferred<void>();
    const failure = new Error('cleanup failed');
    const manager = createManager();
    const handle = manager.submit({
      type: 'metadata_probe',
      execute: async () => {
        await execution.promise;
        throw failure;
      },
    });
    const result = handle.result.catch((error: unknown) => error);
    await schedulingTurn();

    const cancel = manager.cancel(handle.id);
    execution.resolve();

    await expect(cancel).rejects.toBe(failure);
    expect(await result).toBe(failure);
    expect(manager.getSnapshot()[0]).toMatchObject({
      status: 'failed',
      failureReason: 'cleanup failed',
    });
  });

  it('exposes manager cancellation to post-processing through the task signal', async () => {
    const postProcessing = deferred<void>();
    const manager = createManager();
    let taskSignal: AbortSignal | undefined;
    const handle = manager.submit({
      type: 'media_download',
      execute: async (operations) => {
        taskSignal = operations.signal;
        await postProcessing.promise;
      },
    });
    const result = handle.result.catch((error: unknown) => error);
    await schedulingTurn();

    const cancel = manager.cancel(handle.id);
    expect(taskSignal?.aborted).toBe(true);
    expect(manager.getSnapshot()[0]?.status).toBe('running');

    postProcessing.resolve();
    await cancel;
    expect(await result).toEqual(new Error('yt-dlp task canceled'));
    expect(manager.getSnapshot()[0]?.status).toBe('canceled');
  });

  it('stops once, cancels all active tasks, and rejects later submissions', async () => {
    const cleanup = deferred<void>();
    const manager = createManager();
    const running = manager.submit({
      type: 'media_download',
      execute: () => cleanup.promise,
    });
    const queuedExecute = vi.fn(async () => undefined);
    const queued = manager.submit({
      type: 'media_download',
      execute: queuedExecute,
    });
    const results = [running.result.catch(() => undefined), queued.result.catch(() => undefined)];
    await schedulingTurn();

    const firstStop = manager.stop();
    const secondStop = manager.stop();
    expect(secondStop).toBe(firstStop);
    expect(() =>
      manager.submit({
        type: 'metadata_probe',
        execute: async () => undefined,
      }),
    ).toThrow('yt-dlp task manager is stopping');

    let stopped = false;
    void firstStop.then(() => {
      stopped = true;
    });
    await schedulingTurn();
    expect(stopped).toBe(false);
    expect(queuedExecute).not.toHaveBeenCalled();

    cleanup.resolve();
    await firstStop;
    await Promise.all(results);
    expect(manager.getSnapshot().map(({ status }) => status)).toEqual([
      'canceled',
      'canceled',
    ]);
  });
});
