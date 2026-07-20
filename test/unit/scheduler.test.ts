import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, type DatabaseConnection } from '../../src/db/client.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { BusinessError } from '../../src/errors.js';
import {
  ChannelScheduler,
  type SchedulerClock,
} from '../../src/scheduler.js';
import { YtDlpTaskCancellationError } from '../../src/yt-dlp-task-manager.js';

class FakeClock implements SchedulerClock {
  #callback: (() => void) | undefined;
  #now: Date;
  intervalMilliseconds: number | undefined;

  constructor(now: string) {
    this.#now = new Date(now);
  }

  now(): Date {
    return new Date(this.#now);
  }

  setNow(now: string): void {
    this.#now = new Date(now);
  }

  setInterval(callback: () => void, milliseconds: number): unknown {
    this.#callback = callback;
    this.intervalMilliseconds = milliseconds;
    return callback;
  }

  clearInterval(timer: unknown): void {
    if (timer === this.#callback) {
      this.#callback = undefined;
    }
  }

  fire(): void {
    this.#callback?.();
  }
}

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

let database: DatabaseConnection;
let channelSequence: number;

function setGlobalInterval(minutes: number): void {
  database
    .prepare('UPDATE settings SET global_check_interval_minutes = ? WHERE id = 1')
    .run(minutes);
}

function insertChannel(
  initialSyncedAt: string,
  checkIntervalMinutes: number | null = null,
  lastCheckStartedAt: string | null = null,
): number {
  channelSequence += 1;
  const result = database
    .prepare(
      `INSERT INTO channels (
        platform, platform_channel_id, source_url, custom_name,
        custom_name_key, check_interval_minutes, initial_synced_at,
        last_check_started_at, created_at, updated_at
      ) VALUES ('youtube', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `channel-${channelSequence}`,
      'https://www.youtube.com/@fixture',
      `Channel ${channelSequence}`,
      `channel-${channelSequence}`,
      checkIntervalMinutes,
      initialSyncedAt,
      lastCheckStartedAt,
      initialSyncedAt,
      initialSyncedAt,
    );
  return Number(result.lastInsertRowid);
}

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database);
  channelSequence = 0;
});

afterEach(() => {
  database.close();
});

describe('ChannelScheduler', () => {
  it('ignores channels that have not completed initial synchronization', async () => {
    setGlobalInterval(1);
    database
      .prepare(
        `INSERT INTO channels (
          platform, extractor, platform_channel_id, source_url, custom_name,
          custom_name_key, initial_sync_status, created_at, updated_at
        ) VALUES ('youtube', 'YoutubeTab', NULL, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        'https://www.youtube.com/@pending',
        'Pending',
        'pending',
        '2026-07-17T10:00:00.000Z',
        '2026-07-17T10:00:00.000Z',
      );
    const check = vi.fn(() => Promise.resolve());
    const scheduler = new ChannelScheduler(
      database,
      check,
      new FakeClock('2026-07-17T11:00:00.000Z'),
    );

    await scheduler.tick();
    expect(check).not.toHaveBeenCalled();
  });

  it('dispatches exactly at the initial synchronization due boundary', async () => {
    setGlobalInterval(5);
    const channelId = insertChannel('2026-07-17T10:00:00.000Z');
    const clock = new FakeClock('2026-07-17T10:04:59.999Z');
    const check = vi.fn(() => Promise.resolve());
    const scheduler = new ChannelScheduler(database, check, clock);

    await scheduler.tick();
    expect(check).not.toHaveBeenCalled();

    clock.setNow('2026-07-17T10:05:00.000Z');
    await scheduler.tick();
    expect(check).toHaveBeenCalledOnce();
    expect(check).toHaveBeenCalledWith(
      channelId,
      new Date('2026-07-17T10:05:00.000Z'),
    );
  });

  it('uses the channel interval override as the only priority over the global interval', async () => {
    setGlobalInterval(5);
    const globalChannelId = insertChannel('2026-07-17T10:00:00.000Z');
    const overrideChannelId = insertChannel(
      '2026-07-17T10:00:00.000Z',
      10,
    );
    const fasterOverrideChannelId = insertChannel(
      '2026-07-17T10:00:00.000Z',
      3,
    );
    const clock = new FakeClock('2026-07-17T10:06:00.000Z');
    const checkedIds: number[] = [];
    const scheduler = new ChannelScheduler(
      database,
      async (channelId) => {
        checkedIds.push(channelId);
      },
      clock,
    );

    await scheduler.tick();

    expect(checkedIds).toEqual([globalChannelId, fasterOverrideChannelId]);
    expect(checkedIds).not.toContain(overrideChannelId);
  });

  it('uses the last check start time and prevents the same channel from reentering', async () => {
    setGlobalInterval(5);
    const channelId = insertChannel(
      '2026-07-17T09:00:00.000Z',
      null,
      '2026-07-17T10:00:00.000Z',
    );
    const clock = new FakeClock('2026-07-17T10:05:00.000Z');
    const firstCheck = deferred();
    const check = vi.fn(async (_channelId: number, startedAt: Date) => {
      database
        .prepare('UPDATE channels SET last_check_started_at = ? WHERE id = ?')
        .run(startedAt.toISOString(), channelId);
      if (check.mock.calls.length === 1) {
        await firstCheck.promise;
      }
    });
    const scheduler = new ChannelScheduler(database, check, clock);

    const firstTick = scheduler.tick();
    clock.setNow('2026-07-17T10:10:00.000Z');
    await scheduler.tick();
    expect(check).toHaveBeenCalledOnce();

    firstCheck.resolve();
    await firstTick;
    await scheduler.tick();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('settles all due channels and propagates a rejected channel check', async () => {
    setGlobalInterval(1);
    const failedChannelId = insertChannel('2026-07-17T10:00:00.000Z');
    const successfulChannelId = insertChannel('2026-07-17T10:00:00.000Z');
    const clock = new FakeClock('2026-07-17T10:01:00.000Z');
    const checkedIds: number[] = [];
    const scheduler = new ChannelScheduler(
      database,
      async (channelId) => {
        checkedIds.push(channelId);
        if (channelId === failedChannelId) {
          throw new Error('fixture failure');
        }
      },
      clock,
    );

    await expect(scheduler.tick()).rejects.toThrow('scheduled channel check failed');
    expect(checkedIds).toEqual([failedChannelId, successfulChannelId]);

    checkedIds.length = 0;
    await expect(scheduler.tick()).rejects.toThrow('scheduled channel check failed');
    expect(checkedIds).toEqual([failedChannelId, successfulChannelId]);
  });

  it.each(['CHANNEL_FETCH_FAILED', 'CHANNEL_METADATA_INVALID'] as const)(
    'isolates an already-recorded %s channel failure',
    async (code) => {
      setGlobalInterval(1);
      insertChannel('2026-07-17T10:00:00.000Z');
      const scheduler = new ChannelScheduler(
        database,
        async () => {
          throw new BusinessError(code, 'recorded channel failure');
        },
        new FakeClock('2026-07-17T10:01:00.000Z'),
      );

      await expect(scheduler.tick()).resolves.toBeUndefined();
    },
  );

  it('does not propagate a canceled scheduled channel check', async () => {
    setGlobalInterval(1);
    insertChannel('2026-07-17T10:00:00.000Z');
    const scheduler = new ChannelScheduler(
      database,
      async () => {
        throw new YtDlpTaskCancellationError();
      },
      new FakeClock('2026-07-17T10:01:00.000Z'),
    );

    await expect(scheduler.tick()).resolves.toBeUndefined();
  });

  it('propagates a scheduled channel persistence failure', async () => {
    setGlobalInterval(1);
    insertChannel('2026-07-17T10:00:00.000Z');
    const scheduler = new ChannelScheduler(
      database,
      async () => {
        throw new BusinessError('PERSISTENCE_ERROR', 'database unavailable');
      },
      new FakeClock('2026-07-17T10:01:00.000Z'),
    );

    await expect(scheduler.tick()).rejects.toThrow('scheduled channel check failed');
  });

  it('reports a scheduled tick failure and continues on the next interval', async () => {
    setGlobalInterval(1);
    insertChannel('2026-07-17T10:00:00.000Z');
    const clock = new FakeClock('invalid');
    const check = vi.fn(() => Promise.resolve());
    const reportError = vi.fn();
    const scheduler = new ChannelScheduler(database, check, clock, reportError);

    scheduler.start();
    clock.fire();
    await vi.waitFor(() =>
      expect(reportError).toHaveBeenCalledWith(
        new Error('scheduler clock returned an invalid time'),
      ),
    );

    clock.setNow('2026-07-17T10:01:00.000Z');
    clock.fire();
    await vi.waitFor(() => expect(check).toHaveBeenCalledOnce());
    expect(reportError).toHaveBeenCalledOnce();

    await scheduler.stop();
  });

  it('keeps direct tick failures as rejected promises', async () => {
    const clock = new FakeClock('invalid');
    const reportError = vi.fn();
    const scheduler = new ChannelScheduler(
      database,
      vi.fn(() => Promise.resolve()),
      clock,
      reportError,
    );

    await expect(scheduler.tick()).rejects.toThrow(
      'scheduler clock returned an invalid time',
    );
    expect(reportError).not.toHaveBeenCalled();
  });

  it('ticks every 60 seconds and stop prevents new ticks while awaiting running checks', async () => {
    setGlobalInterval(1);
    insertChannel('2026-07-17T10:00:00.000Z');
    const clock = new FakeClock('2026-07-17T10:01:00.000Z');
    const runningCheck = deferred();
    const check = vi.fn(() => runningCheck.promise);
    const scheduler = new ChannelScheduler(database, check, clock);

    scheduler.start();
    expect(clock.intervalMilliseconds).toBe(60_000);
    clock.fire();
    await vi.waitFor(() => expect(check).toHaveBeenCalledOnce());

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    clock.fire();
    await Promise.resolve();
    expect(check).toHaveBeenCalledOnce();
    expect(stopped).toBe(false);

    runningCheck.resolve();
    await stopping;
    clock.fire();
    await Promise.resolve();
    expect(check).toHaveBeenCalledOnce();
  });
});
