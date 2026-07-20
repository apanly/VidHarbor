import type { Readable } from 'node:stream';

interface ResponseCloseEmitter {
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
  once(event: 'close', listener: () => void): unknown;
}

export function closeReadableOnPrematureResponseClose(
  readable: Readable,
  response: ResponseCloseEmitter,
): void {
  const closeReadable = () => {
    if (!response.writableEnded) readable.destroy();
  };
  response.once('close', closeReadable);
  if (response.destroyed) closeReadable();
}
