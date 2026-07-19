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
  assertVideoTargetAvailable,
  prepareChannelArchiveDirectory,
  resolveDirectDownloadDirectory,
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

describe('archive directories', () => {
  it('creates and returns the fixed channel name and year path', async () => {
    const archiveDirectory = await prepareChannelArchiveDirectory(
      downloadRoot,
      mountPath,
      '示例频道',
      2026,
    );

    expect(archiveDirectory).toBe(
      join(await realpath(downloadRoot), '示例频道', '2026'),
    );
    await expect(realpath(archiveDirectory)).resolves.toBe(archiveDirectory);
  });

  it('returns the configured root for a direct download without creating a child', async () => {
    await expect(
      resolveDirectDownloadDirectory(downloadRoot, mountPath),
    ).resolves.toBe(await realpath(downloadRoot));
  });

  it.each([0, 999, 10_000, 2026.5])(
    'rejects the invalid explicit year %j',
    async (year) => {
      await expectBusinessError(
        prepareChannelArchiveDirectory(
          downloadRoot,
          mountPath,
          'channel',
          year,
        ),
        'VALIDATION_ERROR',
      );
    },
  );

  it('rejects an existing channel symlink that escapes the root', async () => {
    const outside = join(sandbox, 'outside');
    await mkdir(outside);
    await symlink(outside, join(downloadRoot, 'channel'), 'dir');

    await expectBusinessError(
      prepareChannelArchiveDirectory(downloadRoot, mountPath, 'channel', 2026),
      'VALIDATION_ERROR',
    );
    await expect(access(join(outside, '2026'))).rejects.toThrow();
  });

  it('rejects an existing year symlink that escapes the root', async () => {
    const outside = join(sandbox, 'outside');
    const channelDirectory = join(downloadRoot, 'channel');
    await mkdir(outside);
    await mkdir(channelDirectory);
    await symlink(outside, join(channelDirectory, '2026'), 'dir');

    await expectBusinessError(
      prepareChannelArchiveDirectory(downloadRoot, mountPath, 'channel', 2026),
      'VALIDATION_ERROR',
    );
  });
});

describe('assertVideoTargetAvailable', () => {
  const videoId = 'aB_12-cD345';

  it('allows a directory without a regular file for the same video ID', async () => {
    await writeFile(join(downloadRoot, 'different.mp4'), 'media');

    await expect(
      assertVideoTargetAvailable(downloadRoot, mountPath, downloadRoot, videoId),
    ).resolves.toBeUndefined();
  });

  it.each(['mp4', 'webm', 'unknown'])(
    'rejects an existing regular file with the same ID and .%s extension',
    async (extension) => {
      await writeFile(join(downloadRoot, `${videoId}.${extension}`), 'media');

      await expectBusinessError(
        assertVideoTargetAvailable(
          downloadRoot,
          mountPath,
          downloadRoot,
          videoId,
        ),
        'DOWNLOAD_ALREADY_EXISTS',
      );
    },
  );

  it('rejects a target directory symlink that escapes the root', async () => {
    const outside = join(sandbox, 'outside');
    const linkedDirectory = join(downloadRoot, 'linked');
    await mkdir(outside);
    await symlink(outside, linkedDirectory, 'dir');

    await expectBusinessError(
      assertVideoTargetAvailable(downloadRoot, mountPath, linkedDirectory, videoId),
      'VALIDATION_ERROR',
    );
  });
});
