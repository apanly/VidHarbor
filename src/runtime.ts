import type { Response } from 'express';

import { BusinessError } from './errors.js';

type RuntimeErrorReporter = (error: unknown) => void;

export class RuntimeCoordinator {
  readonly #initialSyncTasks = new Set<Promise<void>>();
  readonly #downloadEventStreams = new Set<Response>();
  readonly #reportError: RuntimeErrorReporter;

  constructor(reportError: RuntimeErrorReporter) {
    this.#reportError = reportError;
  }

  trackInitialSync(task: Promise<unknown>): void {
    let tracked: Promise<void>;
    tracked = task
      .then(() => undefined)
      .catch((error: unknown) => {
        if (!(error instanceof BusinessError) || error.code === 'PERSISTENCE_ERROR') {
          this.#reportError(error);
        }
      })
      .finally(() => {
        this.#initialSyncTasks.delete(tracked);
      });
    this.#initialSyncTasks.add(tracked);
  }

  async waitForInitialSyncTasks(): Promise<void> {
    await Promise.all([...this.#initialSyncTasks]);
  }

  reportError(error: unknown): void {
    this.#reportError(error);
  }

  registerDownloadEventStream(response: Response): () => void {
    this.#downloadEventStreams.add(response);
    return () => {
      this.#downloadEventStreams.delete(response);
    };
  }

  closeDownloadEventStreams(): void {
    for (const response of this.#downloadEventStreams) response.end();
    this.#downloadEventStreams.clear();
  }
}
