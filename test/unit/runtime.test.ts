import { describe, expect, it } from 'vitest';

import { RuntimeCoordinator } from '../../src/runtime.js';

describe('runtime coordinator', () => {
  it('reports runtime failures', () => {
    const errors: unknown[] = [];
    const runtime = new RuntimeCoordinator((error) => errors.push(error));
    const error = new Error('runtime failure');

    runtime.reportError(error);

    expect(errors).toEqual([error]);
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
