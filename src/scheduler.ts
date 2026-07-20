import type { DatabaseConnection } from './db/client.js';
import { BusinessError } from './errors.js';
import { isYtDlpTaskCancellationError } from './yt-dlp-task-manager.js';

const TICK_INTERVAL_MILLISECONDS = 60_000;
const MINUTE_MILLISECONDS = 60_000;

interface ChannelScheduleRow {
  readonly id: number;
  readonly check_interval_minutes: number | null;
  readonly initial_synced_at: string | null;
  readonly last_check_started_at: string | null;
  readonly next_check_at: string | null;
  readonly paused_at: string | null;
  readonly global_check_interval_minutes: number | null;
}

export interface SchedulerClock {
  now(): Date;
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(timer: unknown): void;
}

export type ScheduledChannelCheck = (
  channelId: number,
  startedAt: Date,
) => Promise<unknown>;

export type SchedulerErrorReporter = (error: unknown) => void;

const systemClock: SchedulerClock = {
  now: () => new Date(),
  setInterval: (callback, milliseconds) =>
    globalThis.setInterval(callback, milliseconds),
  clearInterval: (timer) =>
    globalThis.clearInterval(timer as ReturnType<typeof setInterval>),
};

const defaultErrorReporter: SchedulerErrorReporter = (error) => {
  console.error(error);
};

function isRecordedChannelFailure(error: unknown): boolean {
  return (
    error instanceof BusinessError &&
    (error.code === 'CHANNEL_FETCH_FAILED' ||
      error.code === 'CHANNEL_METADATA_INVALID')
  );
}

function loadChannelSchedules(
  database: DatabaseConnection,
): ChannelScheduleRow[] {
  return database
    .prepare(
      `SELECT c.id, c.check_interval_minutes, c.initial_synced_at,
              c.last_check_started_at, c.next_check_at, c.paused_at,
              s.global_check_interval_minutes
       FROM channels c
       CROSS JOIN settings s
       WHERE s.id = 1 AND c.initial_sync_status = 'succeeded'
       ORDER BY c.id`,
    )
    .all() as ChannelScheduleRow[];
}

function isDue(row: ChannelScheduleRow, nowMilliseconds: number): boolean {
  const intervalMinutes =
    row.check_interval_minutes ?? row.global_check_interval_minutes;
  if (row.paused_at !== null) {
    return false;
  }
  if (intervalMinutes === null) {
    throw new Error(`channel ${row.id} has no check interval`);
  }

  if (row.initial_synced_at === null) throw new Error(`channel ${row.id} is not initially synchronized`);
  const previousStart = new Date(row.next_check_at ?? row.last_check_started_at ?? row.initial_synced_at).getTime();
  if (!Number.isFinite(previousStart)) {
    throw new Error(`channel ${row.id} has an invalid check start time`);
  }

  return (
    nowMilliseconds >=
    previousStart + (row.next_check_at === null ? intervalMinutes * MINUTE_MILLISECONDS : 0)
  );
}

export class ChannelScheduler {
  readonly #database: DatabaseConnection;
  readonly #checkScheduledChannel: ScheduledChannelCheck;
  readonly #clock: SchedulerClock;
  readonly #reportError: SchedulerErrorReporter;
  readonly #runningChecks = new Map<number, Promise<unknown>>();
  #timer: unknown;

  constructor(
    database: DatabaseConnection,
    checkScheduledChannel: ScheduledChannelCheck,
    clock: SchedulerClock = systemClock,
    reportError: SchedulerErrorReporter = defaultErrorReporter,
  ) {
    this.#database = database;
    this.#checkScheduledChannel = checkScheduledChannel;
    this.#clock = clock;
    this.#reportError = reportError;
  }

  start(): void {
    if (this.#timer !== undefined) {
      throw new Error('scheduler is already started');
    }
    this.#timer = this.#clock.setInterval(() => {
      if (this.#timer !== undefined) {
        void this.tick().catch((error: unknown) => {
          this.#reportError(error);
        });
      }
    }, TICK_INTERVAL_MILLISECONDS);
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) {
      this.#clock.clearInterval(this.#timer);
      this.#timer = undefined;
    }
    await Promise.allSettled([...this.#runningChecks.values()]);
  }

  async tick(): Promise<void> {
    const startedAt = this.#clock.now();
    const nowMilliseconds = startedAt.getTime();
    if (!Number.isFinite(nowMilliseconds)) {
      throw new Error('scheduler clock returned an invalid time');
    }

    const checks: Promise<unknown>[] = [];
    for (const channel of loadChannelSchedules(this.#database)) {
      if (
        this.#runningChecks.has(channel.id) ||
        !isDue(channel, nowMilliseconds)
      ) {
        continue;
      }

      const check = Promise.resolve()
        .then(() => this.#checkScheduledChannel(channel.id, new Date(startedAt)))
        .finally(() => {
          this.#runningChecks.delete(channel.id);
        });
      this.#runningChecks.set(channel.id, check);
      checks.push(check);
    }

    const results = await Promise.allSettled(checks);
    const failures = results.flatMap((result) =>
      // A canceled check has already converged its manager and channel state.
      result.status === 'rejected' &&
      !isRecordedChannelFailure(result.reason) &&
      !isYtDlpTaskCancellationError(result.reason)
        ? [result.reason as unknown]
        : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'scheduled channel check failed');
    }
  }
}
