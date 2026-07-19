import { describe, expect, it } from 'vitest';

import { BusinessError } from '../../src/errors.js';
import { RuntimeCoordinator } from '../../src/runtime.js';

describe('runtime coordinator', () => {
  it('waits for active initial synchronizations', async () => {
    let finish!: () => void;
    const task = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const runtime = new RuntimeCoordinator(() => undefined);
    runtime.trackInitialSync(task);

    let stopped = false;
    const waiting = runtime.waitForInitialSyncTasks().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finish();
    await waiting;
    expect(stopped).toBe(true);
  });

  it('reports persistence failures but not recorded channel failures', async () => {
    const errors: unknown[] = [];
    const runtime = new RuntimeCoordinator((error) => errors.push(error));
    runtime.trackInitialSync(Promise.reject(
      new BusinessError('CHANNEL_FETCH_FAILED', 'recorded failure'),
    ));
    runtime.trackInitialSync(Promise.reject(
      new BusinessError('PERSISTENCE_ERROR', 'database failed'),
    ));

    await runtime.waitForInitialSyncTasks();
    expect(errors).toEqual([
      expect.objectContaining({ code: 'PERSISTENCE_ERROR' }),
    ]);
  });

  it('closes registered download event streams', () => {
    let ended = 0;
    const response = { end: () => { ended += 1; } };
    const runtime = new RuntimeCoordinator(() => undefined);
    runtime.registerDownloadEventStream(response as never);

    runtime.closeDownloadEventStreams();
    runtime.closeDownloadEventStreams();

    expect(ended).toBe(1);
  });
});
