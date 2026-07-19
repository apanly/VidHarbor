import { access, mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type DatabaseConnection } from '../../src/db/client.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { BusinessError } from '../../src/errors.js';
import {
  getSettings,
  updateSettings,
} from '../../src/services/settings.js';
import {
  createProxy,
  deleteProxy,
  listProxies,
  updateProxy,
} from '../../src/services/proxy.js';

let sandbox: string;
let mountPath: string;
let downloadRoot: string;
let database: DatabaseConnection;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'vidharbor-settings-proxy-'));
  mountPath = join(sandbox, 'downloads');
  downloadRoot = join(mountPath, 'library');
  await mkdir(downloadRoot, { recursive: true });
  database = openDatabase(join(sandbox, 'vidharbor.sqlite'));
  migrateDatabase(database);
});

afterEach(async () => {
  try {
    database.close();
  } catch {
    // A persistence-boundary test may already have closed the connection.
  }
  await rm(sandbox, { recursive: true, force: true });
});

function expectBusinessError(
  operation: (() => unknown) | Promise<unknown>,
  code: BusinessError['code'],
): Promise<void> | void {
  if (typeof operation === 'function') {
    expect(operation).toThrow(expect.objectContaining({ code }));
    return;
  }
  return expect(operation).rejects.toMatchObject({ code });
}

describe('settings service', () => {
  it('reads and updates only the singleton settings row', async () => {
    const realDownloadRoot = await realpath(downloadRoot);

    expect(getSettings(database, mountPath)).toEqual({
      downloadRoot: mountPath,
      globalCheckIntervalMinutes: 60,
      downloadConcurrency: 1,
    });

    await expect(
      updateSettings(database, mountPath, {
        downloadRoot,
        globalCheckIntervalMinutes: 60,
        downloadConcurrency: 2,
      }),
    ).resolves.toEqual({
      downloadRoot: realDownloadRoot,
      globalCheckIntervalMinutes: 60,
      downloadConcurrency: 2,
    });

    expect(getSettings(database, mountPath)).toEqual({
      downloadRoot: realDownloadRoot,
      globalCheckIntervalMinutes: 60,
      downloadConcurrency: 2,
    });
    expect(
      database.prepare('SELECT id FROM settings').pluck().all(),
    ).toEqual([1]);
  });

  it.each([
    (root: string) => ({
      downloadRoot: root,
      globalCheckIntervalMinutes: 1,
      downloadConcurrency: 1,
      extra: true,
    }),
    (root: string) => ({ downloadRoot: root }),
    (root: string) => ({
      downloadRoot: root,
      globalCheckIntervalMinutes: 0,
      downloadConcurrency: 1,
    }),
    (root: string) => ({
      downloadRoot: root,
      globalCheckIntervalMinutes: 1.5,
      downloadConcurrency: 1,
    }),
    (root: string) => ({
      downloadRoot: root,
      globalCheckIntervalMinutes: 1,
      downloadConcurrency: 0,
    }),
    () => ({ downloadRoot: 42, globalCheckIntervalMinutes: 1, downloadConcurrency: 1 }),
  ])('rejects the non-contract settings input %#', async (createInput) => {
    await expectBusinessError(
      updateSettings(database, mountPath, createInput(downloadRoot)),
      'VALIDATION_ERROR',
    );
  });

  it('rejects relative and outside-mount download roots', async () => {
    await expectBusinessError(
      updateSettings(database, mountPath, {
        downloadRoot: 'downloads/library',
        globalCheckIntervalMinutes: 30,
        downloadConcurrency: 1,
      }),
      'VALIDATION_ERROR',
    );

    const outsideRoot = join(sandbox, 'outside');
    await mkdir(outsideRoot);
    await expectBusinessError(
      updateSettings(database, mountPath, {
        downloadRoot: outsideRoot,
        globalCheckIntervalMinutes: 30,
        downloadConcurrency: 1,
      }),
      'DOWNLOAD_ROOT_OUTSIDE_MOUNT',
    );
  });

  it('does not create a missing download root', async () => {
    const missingRoot = join(mountPath, 'missing');

    await expectBusinessError(
      updateSettings(database, mountPath, {
        downloadRoot: missingRoot,
        globalCheckIntervalMinutes: 30,
        downloadConcurrency: 1,
      }),
      'DOWNLOAD_ROOT_UNAVAILABLE',
    );
    await expect(access(missingRoot)).rejects.toThrow();
  });
});

describe('proxy service', () => {
  it('creates, lists, and fully updates structured proxies while retaining passwords only in SQLite', () => {
    const created = createProxy(database, {
      name: 'office',
      protocol: 'http',
      host: 'proxy.example',
      port: 8080,
      username: 'user',
      password: 'secret',
    });

    expect(created).toEqual({
      id: expect.any(Number),
      name: 'office',
      protocol: 'http',
      host: 'proxy.example',
      port: 8080,
      username: 'user',
      maskedPassword: 'se****',
    });
    expect(listProxies(database)).toEqual([created]);
    expect(
      database
        .prepare('SELECT proxy_url FROM proxies WHERE id = ?')
        .pluck()
        .get(created.id),
    ).toBe('http://user:secret@proxy.example:8080');

    expect(
      updateProxy(database, created.id, {
        name: 'home',
        protocol: 'socks5',
        host: 'localhost',
        port: 1080,
        username: null,
        password: null,
      }),
    ).toEqual({
      id: created.id,
      name: 'home',
      protocol: 'socks5',
      host: 'localhost',
      port: 1080,
      username: null,
      maskedPassword: null,
    });
  });

  it.each(['http', 'https', 'socks5'])(
    'accepts the listed %s protocol',
    (protocol) => {
      expect(
        createProxy(database, {
          name: protocol,
          protocol,
          host: 'proxy.example',
          port: 8080,
          username: null,
          password: null,
        }),
      ).toMatchObject({ name: protocol });
    },
  );

  it.each(['ftp', 'HTTP', 'socks5h'])(
    'rejects the non-contract proxy protocol %j',
    (protocol) => {
      expectBusinessError(
        () =>
          createProxy(database, {
            name: 'proxy',
            protocol,
            host: 'proxy.example',
            port: 8080,
            username: null,
            password: null,
          }),
        'VALIDATION_ERROR',
      );
    },
  );

  it.each([
    { name: ' proxy', protocol: 'http', host: 'proxy.example', port: 8080, username: null, password: null },
    { name: 'proxy ', protocol: 'http', host: 'proxy.example', port: 8080, username: null, password: null },
    { name: '', protocol: 'http', host: 'proxy.example', port: 8080, username: null, password: null },
    { name: 'x'.repeat(81), protocol: 'http', host: 'proxy.example', port: 8080, username: null, password: null },
    { name: 'proxy', protocol: 'http', host: '', port: 8080, username: null, password: null },
    { name: 'proxy', protocol: 'http', host: 'proxy example', port: 8080, username: null, password: null },
    { name: 'proxy', protocol: 'http', host: '%', port: 8080, username: null, password: null },
    { name: 'proxy', protocol: 'http', host: 'proxy.example', port: 0, username: null, password: null },
    { name: 'proxy', protocol: 'http', host: 'proxy.example', port: 65536, username: null, password: null },
    { name: 'proxy', protocol: 'http', host: 'proxy.example', port: 8080, username: 'user', password: null },
    { name: 'proxy', protocol: 'http', host: 'proxy.example', port: 8080, username: null, password: 'secret' },
    { name: 'proxy', protocol: 'http', host: 'proxy.example', port: 8080, username: null, password: null, extra: true },
    { name: 'proxy', url: 'http://proxy.example:8080' },
    { name: 'proxy' },
    { protocol: 'http', host: 'proxy.example', port: 8080, username: null, password: null },
  ])('rejects the non-contract proxy input %#', (input) => {
    expectBusinessError(
      () => createProxy(database, input),
      'VALIDATION_ERROR',
    );
  });

  it('rejects name conflicts on create and update', () => {
    const first = createProxy(database, {
      name: 'first',
      protocol: 'http',
      host: 'first.example',
      port: 8080,
      username: null,
      password: null,
    });
    const second = createProxy(database, {
      name: 'second',
      protocol: 'http',
      host: 'second.example',
      port: 8080,
      username: null,
      password: null,
    });

    expectBusinessError(
      () =>
        createProxy(database, {
          name: 'first',
          protocol: 'http',
          host: 'another.example',
          port: 8080,
          username: null,
          password: null,
        }),
      'PROXY_NAME_EXISTS',
    );
    expectBusinessError(
      () =>
        updateProxy(database, second.id, {
          name: 'first',
          protocol: 'https',
          host: 'second.example',
          port: 8443,
          username: null,
          password: null,
        }),
      'PROXY_NAME_EXISTS',
    );
    expect(listProxies(database)).toHaveLength(2);
    expect(listProxies(database)[0]).toMatchObject({ id: first.id });
  });

  it('requires both fields for an update and reports missing proxies', () => {
    const proxy = createProxy(database, {
      name: 'proxy',
      protocol: 'http',
      host: 'proxy.example',
      port: 8080,
      username: null,
      password: null,
    });

    expectBusinessError(
      () => updateProxy(database, proxy.id, { name: 'renamed' }),
      'VALIDATION_ERROR',
    );
    expectBusinessError(
      () =>
        updateProxy(database, 999, {
          name: 'missing',
          protocol: 'http',
          host: 'missing.example',
          port: 8080,
          username: null,
          password: null,
        }),
      'PROXY_NOT_FOUND',
    );
    expectBusinessError(() => deleteProxy(database, 999), 'PROXY_NOT_FOUND');
  });

  it('deletes an unreferenced proxy but refuses a channel-referenced proxy', () => {
    const unused = createProxy(database, {
      name: 'unused',
      protocol: 'http',
      host: 'unused.example',
      port: 8080,
      username: null,
      password: null,
    });
    const used = createProxy(database, {
      name: 'used',
      protocol: 'http',
      host: 'used.example',
      port: 8080,
      username: null,
      password: null,
    });
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO channels (
          platform, platform_channel_id, source_url, custom_name,
          custom_name_key, proxy_id, initial_synced_at, created_at, updated_at
        ) VALUES ('youtube', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'UC123',
        'https://www.youtube.com/channel/UC123',
        'channel',
        'channel',
        used.id,
        now,
        now,
        now,
      );

    expect(deleteProxy(database, unused.id)).toBeUndefined();
    expectBusinessError(() => deleteProxy(database, used.id), 'PROXY_IN_USE');
    expect(listProxies(database)).toEqual([
      expect.objectContaining({ id: used.id }),
    ]);
  });
});

describe('persistence error boundary', () => {
  it('maps SQLite failures for every settings and proxy use case', async () => {
    database.close();

    expectBusinessError(() => getSettings(database, mountPath), 'PERSISTENCE_ERROR');
    await expectBusinessError(
      updateSettings(database, mountPath, {
        downloadRoot,
        globalCheckIntervalMinutes: 60,
        downloadConcurrency: 1,
      }),
      'PERSISTENCE_ERROR',
    );
    expectBusinessError(() => listProxies(database), 'PERSISTENCE_ERROR');
    expectBusinessError(
      () =>
        createProxy(database, {
          name: 'proxy',
          protocol: 'http',
          host: 'proxy.example',
          port: 8080,
          username: null,
          password: null,
        }),
      'PERSISTENCE_ERROR',
    );
    expectBusinessError(
      () =>
        updateProxy(database, 1, {
          name: 'proxy',
          protocol: 'http',
          host: 'proxy.example',
          port: 8080,
          username: null,
          password: null,
        }),
      'PERSISTENCE_ERROR',
    );
    expectBusinessError(() => deleteProxy(database, 1), 'PERSISTENCE_ERROR');
  });
});
