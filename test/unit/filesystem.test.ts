import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BusinessError } from '../../src/errors.js';
import {
  validateChannelName,
  validateDownloadFile,
  validateDownloadRoot,
} from '../../src/filesystem.js';

let sandbox: string;
let mountPath: string;
let downloadRoot: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'vidharbor-filesystem-'));
  mountPath = join(sandbox, 'downloads');
  downloadRoot = join(mountPath, 'library');
  await mkdir(downloadRoot, { recursive: true });
});

afterEach(async () => {
  await chmod(downloadRoot, 0o700).catch(() => undefined);
  await rm(sandbox, { recursive: true, force: true });
});

async function expectBusinessError(
  operation: Promise<unknown>,
  code: BusinessError['code'],
): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code });
}

describe('validateChannelName', () => {
  it.each(['频道 Name_01', 'é'.repeat(80), '😀'.repeat(63)])(
    'returns the valid channel name %j unchanged',
    (name) => {
      expect(validateChannelName(name)).toBe(name);
    },
  );

  it('rejects an unpaired surrogate instead of letting UTF-8 encoding rewrite it', () => {
    expect(() => validateChannelName('\ud800')).toThrow();
  });

  it.each([
    '',
    ' leading',
    'trailing ',
    '.',
    '..',
    'path/name',
    'path\\name',
    'nul\0name',
    'line\nname',
    'e\u0301',
    'x'.repeat(81),
    '😀'.repeat(64),
  ])('rejects the non-contract channel name %j', (name) => {
    expect(() => validateChannelName(name)).toThrow();
  });
});

describe('validateDownloadRoot', () => {
  it('returns the real absolute root when it is inside the mount and usable', async () => {
    await expect(validateDownloadRoot(downloadRoot, mountPath)).resolves.toBe(
      await realpath(downloadRoot),
    );
  });

  it('rejects a relative download root', async () => {
    await expectBusinessError(
      validateDownloadRoot('downloads/library', mountPath),
      'VALIDATION_ERROR',
    );
  });

  it('does not create a missing configured root', async () => {
    const missingRoot = join(mountPath, 'missing');

    await expectBusinessError(
      validateDownloadRoot(missingRoot, mountPath),
      'DOWNLOAD_ROOT_UNAVAILABLE',
    );
    await expect(access(missingRoot)).rejects.toThrow();
  });

  it('rejects a root outside the configured mount', async () => {
    const outsideRoot = join(sandbox, 'outside');
    await mkdir(outsideRoot);

    await expectBusinessError(
      validateDownloadRoot(outsideRoot, mountPath),
      'DOWNLOAD_ROOT_OUTSIDE_MOUNT',
    );
  });

  it('rejects a root symlink that escapes the configured mount', async () => {
    const outsideRoot = join(sandbox, 'outside');
    const linkedRoot = join(mountPath, 'linked');
    await mkdir(outsideRoot);
    await symlink(outsideRoot, linkedRoot, 'dir');

    await expectBusinessError(
      validateDownloadRoot(linkedRoot, mountPath),
      'DOWNLOAD_ROOT_OUTSIDE_MOUNT',
    );
  });

  it('rejects a root without read, write, and enter permissions', async () => {
    await chmod(downloadRoot, 0o000);

    await expectBusinessError(
      validateDownloadRoot(downloadRoot, mountPath),
      'DOWNLOAD_ROOT_UNAVAILABLE',
    );
  });
});

describe('validateDownloadFile', () => {
  it('returns a readable regular file inside the configured root', async () => {
    const filePath = join(downloadRoot, 'video.webm');
    await writeFile(filePath, 'media');

    const file = await validateDownloadFile(downloadRoot, mountPath, filePath);
    expect(file.path).toBe(await realpath(filePath));
    expect(file.size).toBe(5);
    await file.handle.close();
  });

  it('rejects unavailable and escaping file paths with one fixed error', async () => {
    const missing = join(downloadRoot, 'missing.webm');
    const directory = join(downloadRoot, 'directory');
    const unreadable = join(downloadRoot, 'unreadable.webm');
    const outsideRoot = join(mountPath, 'outside.webm');
    const linkedOutside = join(downloadRoot, 'linked.webm');
    await mkdir(directory);
    await writeFile(unreadable, 'media');
    await chmod(unreadable, 0o000);
    await writeFile(outsideRoot, 'media');
    await symlink(outsideRoot, linkedOutside);

    try {
      for (const path of [missing, directory, unreadable, outsideRoot, linkedOutside]) {
        await expect(
          validateDownloadFile(downloadRoot, mountPath, path),
        ).rejects.toMatchObject({
          code: 'DOWNLOAD_FILE_UNAVAILABLE',
          message: 'download file unavailable',
        });
      }
    } finally {
      await chmod(unreadable, 0o600);
    }
  });
});
