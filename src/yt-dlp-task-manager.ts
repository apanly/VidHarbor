import {
  downloadMedia,
  downloadThumbnail,
  fetchChannelEntries,
  fetchVideoMetadata,
  type DownloadOptions,
  type FetchOptions,
  type ThumbnailDownloadOptions,
} from './yt-dlp.js';

export const YT_DLP_TASK_TYPES = [
  'media_download',
  'metadata_probe',
  'channel_initial_sync',
  'channel_manual_check',
  'channel_scheduled_check',
] as const;

export type YtDlpTaskType = (typeof YT_DLP_TASK_TYPES)[number];

export type YtDlpTaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled';

type ManagedFetchOptions = Omit<FetchOptions, 'executablePath' | 'signal'>;
type ManagedDownloadOptions = Omit<
  DownloadOptions,
  'executablePath' | 'signal'
>;
type ManagedThumbnailDownloadOptions = Omit<
  ThumbnailDownloadOptions,
  'executablePath' | 'signal'
>;

export interface YtDlpOperations {
  readonly signal: AbortSignal;
  readonly fetchChannelEntries: (
    options: ManagedFetchOptions,
  ) => Promise<readonly unknown[]>;
  readonly fetchVideoMetadata: (
    options: ManagedFetchOptions,
  ) => Promise<unknown>;
  readonly downloadMedia: (options: ManagedDownloadOptions) => Promise<string>;
  readonly downloadThumbnail: (
    options: ManagedThumbnailDownloadOptions,
  ) => Promise<void>;
}

export interface YtDlpTaskSubmission<T> {
  readonly type: YtDlpTaskType;
  readonly execute: (operations: YtDlpOperations) => Promise<T>;
}

export interface YtDlpTaskHandle<T> {
  readonly id: number;
  readonly result: Promise<T>;
}

export interface YtDlpTaskSnapshot {
  readonly id: number;
  readonly type: YtDlpTaskType;
  readonly status: YtDlpTaskStatus;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly failureReason: string | null;
}

interface MutableTaskSnapshot {
  readonly id: number;
  readonly type: YtDlpTaskType;
  status: YtDlpTaskStatus;
  readonly createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  failureReason: string | null;
}

interface ActiveTask {
  readonly id: number;
  readonly type: YtDlpTaskType;
  execute: ((operations: YtDlpOperations) => Promise<unknown>) | undefined;
  controller: AbortController | undefined;
  cancelRequested: boolean;
  failed: boolean;
  failure: unknown;
  readonly resolveResult: (value: unknown) => void;
  readonly rejectResult: (reason: unknown) => void;
  readonly settled: Promise<void>;
  readonly resolveSettled: () => void;
}

const TASK_TYPE_SET = new Set<unknown>(YT_DLP_TASK_TYPES);
const TERMINAL_STATUSES = new Set<YtDlpTaskStatus>([
  'succeeded',
  'failed',
  'canceled',
]);
const SUBMISSION_KEYS = new Set<PropertyKey>(['type', 'execute']);

export class YtDlpTaskCancellationError extends Error {
  constructor() {
    super('yt-dlp task canceled');
  }
}

export function isYtDlpTaskCancellationError(
  error: unknown,
): error is YtDlpTaskCancellationError {
  return error instanceof YtDlpTaskCancellationError;
}

function cancellationError(): Error {
  return new YtDlpTaskCancellationError();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message === '' ? error.name : error.message;
  }
  return String(error);
}

function assertSubmission<T>(
  submission: YtDlpTaskSubmission<T>,
): asserts submission is YtDlpTaskSubmission<T> {
  if (typeof submission !== 'object' || submission === null) {
    throw new TypeError('yt-dlp task submission must be an object');
  }
  for (const key of Reflect.ownKeys(submission)) {
    if (!SUBMISSION_KEYS.has(key)) {
      throw new TypeError(`unsupported yt-dlp task field: ${String(key)}`);
    }
  }
  if (
    !Object.hasOwn(submission, 'type') ||
    !Object.hasOwn(submission, 'execute')
  ) {
    throw new TypeError('yt-dlp task submission requires type and execute');
  }
  if (!TASK_TYPE_SET.has(submission.type)) {
    throw new TypeError(`unsupported yt-dlp task type: ${String(submission.type)}`);
  }
  if (typeof submission.execute !== 'function') {
    throw new TypeError('yt-dlp task execute must be a function');
  }
}

export class YtDlpTaskManager {
  readonly #executablePath: string;
  readonly #downloadConcurrency: number;
  readonly #redactFailureReason: (message: string) => string;
  readonly #snapshots = new Map<number, MutableTaskSnapshot>();
  readonly #activeTasks = new Map<number, ActiveTask>();
  readonly #downloadQueue: number[] = [];
  #nextId = 1;
  #runningDownloads = 0;
  #stopping = false;
  #stopPromise: Promise<void> | undefined;

  constructor(
    executablePath: string,
    downloadConcurrency: number,
    redactFailureReason: (message: string) => string,
  ) {
    if (typeof executablePath !== 'string' || executablePath === '') {
      throw new TypeError('yt-dlp executable path must be a non-empty string');
    }
    if (!Number.isSafeInteger(downloadConcurrency) || downloadConcurrency <= 0) {
      throw new TypeError('download concurrency must be a positive integer');
    }
    if (typeof redactFailureReason !== 'function') {
      throw new TypeError('redact failure reason must be a function');
    }
    this.#executablePath = executablePath;
    this.#downloadConcurrency = downloadConcurrency;
    this.#redactFailureReason = redactFailureReason;
  }

  submit<T>(submission: YtDlpTaskSubmission<T>): YtDlpTaskHandle<T> {
    if (this.#stopping) {
      throw new Error('yt-dlp task manager is stopping');
    }
    assertSubmission(submission);
    if (!Number.isSafeInteger(this.#nextId)) {
      throw new Error('yt-dlp task ID limit reached');
    }

    const id = this.#nextId;
    this.#nextId += 1;
    const createdAt = new Date().toISOString();
    this.#snapshots.set(id, {
      id,
      type: submission.type,
      status: 'queued',
      createdAt,
      startedAt: null,
      finishedAt: null,
      failureReason: null,
    });

    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    this.#activeTasks.set(id, {
      id,
      type: submission.type,
      execute: submission.execute as (
        operations: YtDlpOperations,
      ) => Promise<unknown>,
      controller: undefined,
      cancelRequested: false,
      failed: false,
      failure: undefined,
      resolveResult: resolveResult as (value: unknown) => void,
      rejectResult,
      settled,
      resolveSettled,
    });

    if (submission.type === 'media_download') {
      this.#downloadQueue.push(id);
      queueMicrotask(() => this.#drainDownloadQueue());
    } else {
      queueMicrotask(() => this.#startTask(id));
    }

    return { id, result };
  }

  getSnapshot(): readonly YtDlpTaskSnapshot[] {
    return [...this.#snapshots.values()]
      .sort((left, right) => left.id - right.id)
      .map((task) => ({
        id: task.id,
        type: task.type,
        status: task.status,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        finishedAt: task.finishedAt,
        failureReason: task.failureReason,
      }));
  }

  cancel(id: number): Promise<void> {
    const activeTask = this.#activeTasks.get(id);
    if (activeTask === undefined) return Promise.resolve();

    const snapshot = this.#snapshots.get(id);
    if (snapshot?.status === 'queued') {
      const queueIndex = this.#downloadQueue.indexOf(id);
      if (queueIndex !== -1) this.#downloadQueue.splice(queueIndex, 1);
      this.#finishTask(activeTask, 'canceled', undefined);
      return this.#waitForCancellation(activeTask);
    }
    if (snapshot?.status === 'running' && !activeTask.cancelRequested) {
      activeTask.cancelRequested = true;
      activeTask.controller?.abort(cancellationError());
    }
    return this.#waitForCancellation(activeTask);
  }

  stop(): Promise<void> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    this.#stopping = true;
    const taskIds = [...this.#activeTasks.keys()];
    this.#stopPromise = Promise.all(taskIds.map((id) => this.cancel(id))).then(
      () => undefined,
    );
    return this.#stopPromise;
  }

  #drainDownloadQueue(): void {
    if (this.#stopping) return;
    while (
      this.#runningDownloads < this.#downloadConcurrency &&
      this.#downloadQueue.length > 0
    ) {
      const id = this.#downloadQueue.shift();
      if (id !== undefined) this.#startTask(id);
    }
  }

  #startTask(id: number): void {
    if (this.#stopping) return;
    const activeTask = this.#activeTasks.get(id);
    const snapshot = this.#snapshots.get(id);
    if (
      activeTask === undefined ||
      snapshot === undefined ||
      snapshot.status !== 'queued'
    ) {
      return;
    }

    const execute = activeTask.execute;
    if (execute === undefined) return;
    const controller = new AbortController();
    activeTask.controller = controller;
    snapshot.status = 'running';
    snapshot.startedAt = new Date().toISOString();
    if (activeTask.type === 'media_download') this.#runningDownloads += 1;

    const operations = this.#createOperations(controller.signal);
    void Promise.resolve()
      .then(() => execute(operations))
      .then(
        (value) => {
          if (activeTask.cancelRequested) {
            this.#finishTask(activeTask, 'canceled', undefined);
          } else {
            this.#finishTask(activeTask, 'succeeded', value);
          }
        },
        (error: unknown) => {
          if (isYtDlpTaskCancellationError(error)) {
            this.#finishTask(activeTask, 'canceled', error);
          } else {
            this.#finishTask(activeTask, 'failed', error);
          }
        },
      );
  }

  #finishTask(
    activeTask: ActiveTask,
    status: 'succeeded' | 'failed' | 'canceled',
    outcome: unknown,
  ): void {
    const snapshot = this.#snapshots.get(activeTask.id);
    if (snapshot === undefined || TERMINAL_STATUSES.has(snapshot.status)) return;

    snapshot.status = status;
    snapshot.finishedAt = new Date().toISOString();
    if (status === 'failed') {
      snapshot.failureReason = this.#redactFailureReason(errorMessage(outcome));
      activeTask.failed = true;
      activeTask.failure = outcome;
      activeTask.rejectResult(outcome);
    } else if (status === 'canceled') {
      activeTask.rejectResult(
        isYtDlpTaskCancellationError(outcome) ? outcome : cancellationError(),
      );
    } else {
      activeTask.resolveResult(outcome);
    }

    const wasRunningDownload =
      activeTask.type === 'media_download' && snapshot.startedAt !== null;
    activeTask.controller = undefined;
    activeTask.execute = undefined;
    this.#activeTasks.delete(activeTask.id);
    activeTask.resolveSettled();

    if (wasRunningDownload) {
      this.#runningDownloads -= 1;
      this.#drainDownloadQueue();
    }
  }

  async #waitForCancellation(activeTask: ActiveTask): Promise<void> {
    await activeTask.settled;
    if (activeTask.failed) throw activeTask.failure;
  }

  #createOperations(signal: AbortSignal): YtDlpOperations {
    return {
      signal,
      fetchChannelEntries: (options) =>
        fetchChannelEntries({
          ...options,
          executablePath: this.#executablePath,
          signal,
        }),
      fetchVideoMetadata: (options) =>
        fetchVideoMetadata({
          ...options,
          executablePath: this.#executablePath,
          signal,
        }),
      downloadMedia: (options) =>
        downloadMedia({
          ...options,
          executablePath: this.#executablePath,
          signal,
        }),
      downloadThumbnail: (options) =>
        downloadThumbnail({
          ...options,
          executablePath: this.#executablePath,
          signal,
        }),
    };
  }
}
