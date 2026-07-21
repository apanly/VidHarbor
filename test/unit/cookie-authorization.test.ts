import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BusinessError } from '../../src/errors.js';
import {
  COOKIE_PLATFORMS,
  CookieAuthorizationService,
} from '../../src/services/cookie-authorization.js';

const replacementFailure = vi.hoisted(() => ({
  stage: null as null | 'sync' | 'utimes' | 'rename',
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();

  return {
    ...actual,
    open: async (
      path: Parameters<typeof actual.open>[0],
      flags: string,
      mode?: number,
    ) => {
      const handle = await actual.open(path, flags, mode);
      if (replacementFailure.stage === 'sync') {
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(
          new Error('injected persistence failure'),
        );
      }
      if (replacementFailure.stage === 'utimes') {
        vi.spyOn(handle, 'utimes').mockRejectedValueOnce(
          new Error('injected persistence failure'),
        );
      }
      return handle;
    },
    rename: async (
      oldPath: Parameters<typeof actual.rename>[0],
      newPath: Parameters<typeof actual.rename>[1],
    ) => {
      if (replacementFailure.stage === 'rename') {
        throw new Error('injected persistence failure');
      }
      await actual.rename(oldPath, newPath);
    },
  };
});

const sandboxes: string[] = [];
const VALID_COOKIE_A =
  '.example.test\tTRUE\t/\tFALSE\t0\tsession_a\tsecret-a\n';
const VALID_COOKIE_B =
  '.example.test\tFALSE\t/account\tTRUE\t2147483647\tsession_b\tsecret-b\n';

async function createService(): Promise<{
  readonly sandbox: string;
  readonly storage: string;
  readonly service: CookieAuthorizationService;
}> {
  const sandbox = await mkdtemp(join(tmpdir(), 'vidharbor-cookie-test-'));
  sandboxes.push(sandbox);
  const storage = join(sandbox, 'cookies');
  const service = new CookieAuthorizationService(storage);
  await service.initialize();
  return { sandbox, storage, service };
}

function source(content: string | Buffer): Readable {
  return Readable.from([content]);
}

function mode(value: number): number {
  return value & 0o777;
}

function digest(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function fileDigest(path: string): Promise<string> {
  return digest(await readFile(path));
}

async function replacementSnapshot(
  service: CookieAuthorizationService,
  storage: string,
): Promise<{
  readonly fileDigest: string;
  readonly configured: boolean;
  readonly updatedAt: string | null;
  readonly mtime: string;
}> {
  const configuration = (await service.listConfigurations())[0]!;
  const path = join(storage, 'youtube.cookies.txt');
  return {
    fileDigest: await fileDigest(path),
    configured: configuration.configured,
    updatedAt: configuration.updatedAt,
    mtime: (await stat(path)).mtime.toISOString(),
  };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        throw error;
      }
    }
    await nextTurn();
  }
  throw new Error('temporary file was not created');
}

async function expectBusinessError(
  operation: Promise<unknown>,
  code: 'VALIDATION_ERROR' | 'PERSISTENCE_ERROR',
  message: string,
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught instanceof BusinessError).toBe(true);
  expect(caught instanceof BusinessError ? caught.code : null).toBe(code);
  expect(caught instanceof Error ? caught.message : null).toBe(message);
}

afterEach(async () => {
  replacementFailure.stage = null;
  vi.useRealTimers();
  await Promise.all(
    sandboxes.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('CookieAuthorizationService', () => {
  it('defines the fixed platform order and rejects every unconfirmed platform form', async () => {
    expect(COOKIE_PLATFORMS.map(({ platform }) => platform)).toEqual([
      'youtube',
      'bilibili',
      'x',
      'facebook',
      'douyin',
    ]);
    const { service } = await createService();

    for (const platform of ['YouTube', 'twitter', 'X', 'vimeo', 'custom']) {
      await expectBusinessError(
        service.saveConfiguration(platform, source(VALID_COOKIE_A)),
        'VALIDATION_ERROR',
        'invalid cookie platform',
      );
      await expectBusinessError(
        service.deleteConfiguration(platform),
        'VALIDATION_ERROR',
        'invalid cookie platform',
      );
    }
  });

  it('initializes secure permissions and only removes exact module temporary names', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'vidharbor-cookie-test-'));
    sandboxes.push(sandbox);
    const storage = join(sandbox, 'cookies');
    await mkdir(storage, { mode: 0o777 });
    await chmod(storage, 0o777);
    await writeFile(join(storage, 'youtube.cookies.txt'), VALID_COOKIE_A, {
      mode: 0o666,
    });
    await chmod(join(storage, 'youtube.cookies.txt'), 0o666);
    await writeFile(join(storage, '.youtube.cookies.txt.pending'), 'stale', {
      mode: 0o666,
    });
    await writeFile(join(storage, '.unrelated.pending'), 'keep', {
      mode: 0o600,
    });

    const service = new CookieAuthorizationService(storage);
    await service.initialize();
    const entries = await readdir(storage);

    expect(mode((await stat(storage)).mode)).toBe(0o700);
    expect(mode((await stat(join(storage, 'youtube.cookies.txt'))).mode)).toBe(
      0o600,
    );
    expect(entries.includes('.youtube.cookies.txt.pending')).toBe(false);
    expect(entries.includes('.unrelated.pending')).toBe(true);
  });

  it('allows exact module temporary files to be absent during initialization', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'vidharbor-cookie-test-'));
    sandboxes.push(sandbox);
    const storage = join(sandbox, 'cookies');

    const service = new CookieAuthorizationService(storage);
    await expect(service.initialize()).resolves.toBeUndefined();
  });

  it.each(['symbolic link', 'directory'] as const)(
    'rejects an exact module temporary path that is a %s',
    async (pathType) => {
      const sandbox = await mkdtemp(join(tmpdir(), 'vidharbor-cookie-test-'));
      sandboxes.push(sandbox);
      const storage = join(sandbox, 'cookies');
      const temporaryPath = join(storage, '.youtube.cookies.txt.pending');
      await mkdir(storage);

      if (pathType === 'symbolic link') {
        const target = join(sandbox, 'target');
        await writeFile(target, 'preserve');
        await symlink(target, temporaryPath);
      } else {
        await mkdir(temporaryPath);
      }

      const service = new CookieAuthorizationService(storage);
      await expectBusinessError(
        service.initialize(),
        'PERSISTENCE_ERROR',
        'cookie persistence failed',
      );

      const status = await lstat(temporaryPath);
      expect(
        pathType === 'symbolic link' ? status.isSymbolicLink() : status.isDirectory(),
      ).toBe(true);
    },
  );

  it('lists all five isolated states in fixed order and persists them across instances', async () => {
    const { storage, service } = await createService();
    const initial = await service.listConfigurations();
    expect(initial.map(({ configured }) => configured)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(initial.every(({ updatedAt }) => updatedAt === null)).toBe(true);

    for (const { platform } of COOKIE_PLATFORMS) {
      const saved = await service.saveConfiguration(
        platform,
        source(VALID_COOKIE_A),
      );
      expect(Object.keys(saved).sort()).toEqual([
        'configured',
        'platform',
        'updatedAt',
      ]);
      expect(saved.configured).toBe(true);
    }

    const rebuilt = new CookieAuthorizationService(storage);
    await rebuilt.initialize();
    const persisted = await rebuilt.listConfigurations();
    expect(persisted.map(({ configured }) => configured)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(persisted.every(({ updatedAt }) => updatedAt !== null)).toBe(true);

    const deleted = await rebuilt.deleteConfiguration('x');
    expect(deleted).toEqual({
      platform: 'x',
      configured: false,
      updatedAt: null,
    });
    const afterDelete = await rebuilt.listConfigurations();
    expect(afterDelete.map(({ configured }) => configured)).toEqual([
      true,
      true,
      false,
      true,
      true,
    ]);
  });

  it('fully replaces one file and advances only its successful update time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T08:30:00.000Z'));
    const { storage, service } = await createService();
    const first = await service.saveConfiguration(
      'youtube',
      source(VALID_COOKIE_A),
    );
    const firstDigest = await fileDigest(
      join(storage, 'youtube.cookies.txt'),
    );

    vi.setSystemTime(new Date('2026-07-21T08:30:01.000Z'));
    const second = await service.saveConfiguration(
      'youtube',
      source(VALID_COOKIE_B),
    );
    const secondDigest = await fileDigest(
      join(storage, 'youtube.cookies.txt'),
    );
    const listed = await service.listConfigurations();

    expect(firstDigest).toBe(digest(VALID_COOKIE_A));
    expect(secondDigest).toBe(digest(VALID_COOKIE_B));
    expect(secondDigest === firstDigest).toBe(false);
    expect(first.updatedAt).toBe('2026-07-21T08:30:00.000Z');
    expect(second.updatedAt).toBe('2026-07-21T08:30:01.000Z');
    expect(listed[0]?.updatedAt).toBe(second.updatedAt);
    expect(listed.slice(1).every(({ configured }) => !configured)).toBe(true);
  });

  it('serializes modifications to the same platform in arrival order', async () => {
    const { storage, service } = await createService();
    const firstSource = new PassThrough();
    const first = service.saveConfiguration('youtube', firstSource);
    await nextTurn();

    let secondSettled = false;
    const second = service.saveConfiguration(
      'youtube',
      source(VALID_COOKIE_B),
    );
    void second.then(
      () => {
        secondSettled = true;
      },
      () => {
        secondSettled = true;
      },
    );
    await nextTurn();
    expect(secondSettled).toBe(false);

    firstSource.end(VALID_COOKIE_A);
    await first;
    await second;
    expect(await fileDigest(join(storage, 'youtube.cookies.txt'))).toBe(
      digest(VALID_COOKIE_B),
    );
  });

  it('does not block a different platform behind an unfinished upload', async () => {
    const { service } = await createService();
    const blockedSource = new PassThrough();
    const blocked = service.saveConfiguration('youtube', blockedSource);
    await nextTurn();

    const independent = await service.saveConfiguration(
      'bilibili',
      source(VALID_COOKIE_A),
    );
    expect(independent.configured).toBe(true);

    blockedSource.end(VALID_COOKIE_A);
    await blocked;
  });

  it('creates temporary files with restricted permissions while streaming', async () => {
    const { storage, service } = await createService();
    const input = new PassThrough();
    const saving = service.saveConfiguration('facebook', input);
    const temporaryPath = join(storage, '.facebook.cookies.txt.pending');
    await waitForPath(temporaryPath);

    const temporary = await stat(temporaryPath);
    expect(mode(temporary.mode)).toBe(0o600);

    input.end(VALID_COOKIE_A);
    await saving;
    expect(
      mode((await stat(join(storage, 'facebook.cookies.txt'))).mode),
    ).toBe(0o600);
  });

  it.each([
    ['invalid format', null, 'VALIDATION_ERROR', 'invalid Netscape cookie file'],
    ['sync', 'sync', 'PERSISTENCE_ERROR', 'cookie persistence failed'],
    ['utimes', 'utimes', 'PERSISTENCE_ERROR', 'cookie persistence failed'],
    ['rename', 'rename', 'PERSISTENCE_ERROR', 'cookie persistence failed'],
  ] as const)(
    'keeps the prior file and mtime unchanged when replacement fails at %s',
    async (failureCase, stage, code, message) => {
      const { storage, service } = await createService();
      await service.saveConfiguration('youtube', source(VALID_COOKIE_A));
      const before = await replacementSnapshot(service, storage);
      expect(before.configured).toBe(true);
      replacementFailure.stage = stage;

      const replacement =
        failureCase === 'invalid format'
          ? '.example.test\tTRUE\t/\tFALSE\tbad\tname\tvalue\n'
          : VALID_COOKIE_B;
      let expectedFailure = false;
      try {
        await service.saveConfiguration('youtube', source(replacement));
      } catch (error) {
        expectedFailure =
          error instanceof BusinessError &&
          error.code === code &&
          error.message === message;
      }
      expect(expectedFailure).toBe(true);

      const after = await replacementSnapshot(service, storage);
      expect(after).toEqual(before);
    },
  );

  it('preserves configured state when deletion fails', async () => {
    const { storage, service } = await createService();
    await service.saveConfiguration('douyin', source(VALID_COOKIE_A));
    const before = (await service.listConfigurations())[4];
    await chmod(storage, 0o500);
    try {
      await expectBusinessError(
        service.deleteConfiguration('douyin'),
        'PERSISTENCE_ERROR',
        'cookie persistence failed',
      );
    } finally {
      await chmod(storage, 0o700);
    }
    const after = (await service.listConfigurations())[4];
    expect(after?.configured).toBe(true);
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });

  it('rejects deleting an unconfigured platform explicitly', async () => {
    const { service } = await createService();
    await expectBusinessError(
      service.deleteConfiguration('facebook'),
      'VALIDATION_ERROR',
      'cookie configuration is not configured',
    );
  });

  it('rejects non-regular fixed files without following symbolic links', async () => {
    const { sandbox, storage, service } = await createService();
    await symlink(sandbox, join(storage, 'bilibili.cookies.txt'));
    await expectBusinessError(
      service.listConfigurations(),
      'PERSISTENCE_ERROR',
      'cookie persistence failed',
    );
    await expectBusinessError(
      service.saveConfiguration('bilibili', source(VALID_COOKIE_A)),
      'PERSISTENCE_ERROR',
      'cookie persistence failed',
    );
  });

  it('maps source and filesystem details to the fixed non-sensitive error', async () => {
    const { service } = await createService();
    const sensitiveMarker = 'SENSITIVE_COOKIE_MARKER';
    const failingSource = Readable.from(
      (async function* () {
        throw new Error(sensitiveMarker);
      })(),
    );
    let caught: unknown;
    try {
      await service.saveConfiguration('x', failingSource);
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof BusinessError).toBe(true);
    expect(caught instanceof Error ? caught.message : null).toBe(
      'cookie persistence failed',
    );
    expect(
      caught instanceof Error && caught.message.includes(sensitiveMarker),
    ).toBe(false);
  });
});

describe('Netscape cookie format boundary', () => {
  it.each([
    ['LF records', VALID_COOKIE_A],
    ['CRLF records', VALID_COOKIE_A.replaceAll('\n', '\r\n')],
    ['a final line without a newline', VALID_COOKIE_A.slice(0, -1)],
    [
      'comments and whitespace-only lines',
      `# Netscape HTTP Cookie File\n\t  \t\n${VALID_COOKIE_A}`,
    ],
    [
      'an HttpOnly record and empty value',
      '#HttpOnly_.example.test\tTRUE\t/\tTRUE\t999999999999999999999\tname\t',
    ],
  ])('accepts %s', async (_description, content) => {
    const { service } = await createService();
    const saved = await service.saveConfiguration('youtube', source(content));
    expect(saved.configured).toBe(true);
    expect(saved.updatedAt === null).toBe(false);
  });

  it.each([
    ['no bytes', ''],
    ['only blank lines and comments', '  \n\t\n# comment\r\n'],
  ])('reports an empty file for %s', async (_description, content) => {
    const { storage, service } = await createService();
    await expectBusinessError(
      service.saveConfiguration('youtube', source(content)),
      'VALIDATION_ERROR',
      'cookie file is empty',
    );
    const entries = await readdir(storage);
    expect(entries.some((entry) => entry.endsWith('.pending'))).toBe(false);
  });

  it.each([
    [
      'spaces instead of tabs',
      '.example.test TRUE / FALSE 0 name value\n',
    ],
    ['too few columns', '.example.test\tTRUE\t/\tFALSE\t0\tname\n'],
    [
      'too many columns',
      '.example.test\tTRUE\t/\tFALSE\t0\tname\tvalue\textra\n',
    ],
    [
      'a lowercase boolean',
      '.example.test\ttrue\t/\tFALSE\t0\tname\tvalue\n',
    ],
    [
      'a non-boolean secure field',
      '.example.test\tTRUE\t/\tNO\t0\tname\tvalue\n',
    ],
    [
      'a negative expiration',
      '.example.test\tTRUE\t/\tFALSE\t-1\tname\tvalue\n',
    ],
    [
      'a decimal expiration',
      '.example.test\tTRUE\t/\tFALSE\t1.5\tname\tvalue\n',
    ],
    ['an empty domain', '\tTRUE\t/\tFALSE\t0\tname\tvalue\n'],
    [
      'an empty HttpOnly domain',
      '#HttpOnly_\tTRUE\t/\tFALSE\t0\tname\tvalue\n',
    ],
    [
      'an empty path',
      '.example.test\tTRUE\t\tFALSE\t0\tname\tvalue\n',
    ],
    [
      'an empty expiration',
      '.example.test\tTRUE\t/\tFALSE\t\tname\tvalue\n',
    ],
    [
      'an empty name',
      '.example.test\tTRUE\t/\tFALSE\t0\t\tvalue\n',
    ],
    [
      'a bad line mixed with a valid line',
      `${VALID_COOKIE_A}.example.test\tTRUE\t/\tFALSE\tbad\tname\tvalue\n`,
    ],
    [
      'a lone carriage return',
      '.example.test\tTRUE\t/\tFALSE\t0\tname\tvalue\r',
    ],
  ])('rejects %s', async (_description, content) => {
    const { storage, service } = await createService();
    await expectBusinessError(
      service.saveConfiguration('youtube', source(content)),
      'VALIDATION_ERROR',
      'invalid Netscape cookie file',
    );
    const configurations = await service.listConfigurations();
    expect(configurations[0]?.configured).toBe(false);
    const entries = await readdir(storage);
    expect(entries.some((entry) => entry.endsWith('.pending'))).toBe(false);
  });

  it('validates records incrementally across arbitrary chunk boundaries', async () => {
    const { service } = await createService();
    const content = Buffer.from(
      `# Netscape HTTP Cookie File\r\n${VALID_COOKIE_A}${VALID_COOKIE_B}`,
    );
    const chunks = Array.from(content, (byte) => Buffer.from([byte]));
    const saved = await service.saveConfiguration(
      'facebook',
      Readable.from(chunks),
    );
    expect(saved.configured).toBe(true);
  });
});
