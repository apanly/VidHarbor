import { EventEmitter, once } from 'node:events';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { closeReadableOnPrematureResponseClose } from '../../src/http/file-stream.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('closeReadableOnPrematureResponseClose', () => {
  it('destroys the file stream and closes its handle after client disconnect', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vidharbor-file-stream-'));
    directories.push(directory);
    const path = join(directory, 'large.webm');
    await writeFile(path, 'media');
    const handle = await open(path, 'r');
    const stream = handle.createReadStream();
    const response = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
    });
    const closed = once(stream, 'close');

    closeReadableOnPrematureResponseClose(stream, response);
    response.emit('close');
    await closed;

    expect(stream.destroyed).toBe(true);
    await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
  });

  it('closes the file when the response ended before registration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vidharbor-file-stream-'));
    directories.push(directory);
    const path = join(directory, 'late.webm');
    await writeFile(path, 'media');
    const handle = await open(path, 'r');
    const stream = handle.createReadStream();
    const response = Object.assign(new EventEmitter(), {
      destroyed: true,
      writableEnded: false,
    });
    const closed = once(stream, 'close');

    try {
      closeReadableOnPrematureResponseClose(stream, response);
      expect(stream.destroyed).toBe(true);
    } finally {
      stream.destroy();
      await closed;
    }
    await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
  });
});
