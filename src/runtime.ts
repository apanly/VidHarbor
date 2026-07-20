import type { Response } from 'express';

type RuntimeErrorReporter = (error: unknown) => void;

export class RuntimeCoordinator {
  readonly #downloadEventStreams = new Set<Response>();
  readonly #reportError: RuntimeErrorReporter;

  constructor(reportError: RuntimeErrorReporter) {
    this.#reportError = reportError;
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
