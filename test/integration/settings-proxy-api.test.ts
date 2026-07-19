import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApiRouter, createApp } from '../../src/app.js';
import { RuntimeCoordinator } from '../../src/runtime.js';
import { openDatabase, type DatabaseConnection } from '../../src/db/client.js';
import { migrateDatabase } from '../../src/db/migrate.js';

let sandbox: string;
let mountPath: string;
let downloadRoot: string;
let database: DatabaseConnection;
let baseUrl: string;
let stopServer: (() => Promise<void>) | undefined;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'vidharbor-settings-proxy-api-'));
  mountPath = join(sandbox, 'downloads');
  downloadRoot = join(mountPath, 'library');
  await mkdir(downloadRoot, { recursive: true });

  database = openDatabase(join(sandbox, 'vidharbor.sqlite'));
  migrateDatabase(database);

  const server = createApp(createApiRouter(database, mountPath, new RuntimeCoordinator(() => undefined))).listen(
    0,
    '127.0.0.1',
  );
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  stopServer = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
});

afterEach(async () => {
  await stopServer?.();
  try {
    database.close();
  } catch {
    // A persistence-boundary test may already have closed the connection.
  }
  await rm(sandbox, { recursive: true, force: true });
});

async function request(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers.origin = baseUrl;

  return fetch(`${baseUrl}/api${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('settings API', () => {
  it('gets and replaces the complete settings object', async () => {
    const initialResponse = await request('/settings');
    expect(initialResponse.status).toBe(200);
    await expect(initialResponse.json()).resolves.toEqual({
      downloadRoot: mountPath,
      globalCheckIntervalMinutes: 60,
      downloadConcurrency: 1,
    });

    const updateResponse = await request('/settings', 'PUT', {
      downloadRoot,
      globalCheckIntervalMinutes: 60,
      downloadConcurrency: 2,
    });
    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toEqual({
      downloadRoot: await realpath(downloadRoot),
      globalCheckIntervalMinutes: 60,
      downloadConcurrency: 2,
    });
  });

  it.each([
    (root: string) => ({ downloadRoot: root }),
    (root: string) => ({
      downloadRoot: root,
      globalCheckIntervalMinutes: 30,
      downloadConcurrency: 1,
      extra: true,
    }),
    (root: string) => ({
      download_root: root,
      globalCheckIntervalMinutes: 30,
      downloadConcurrency: 1,
    }),
    (root: string) => ({
      downloadRoot: root,
      globalCheckIntervalMinutes: 1.5,
      downloadConcurrency: 1,
    }),
    (root: string) => ({
      downloadRoot: root,
      globalCheckIntervalMinutes: 30,
      downloadConcurrency: 0,
    }),
  ])('rejects non-contract settings input %#', async (createBody) => {
    const response = await request(
      '/settings',
      'PUT',
      createBody(downloadRoot),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_ERROR' },
    });
  });

  it('maps download-root and persistence failures', async () => {
    const outsideResponse = await request('/settings', 'PUT', {
      downloadRoot: sandbox,
      globalCheckIntervalMinutes: 30,
      downloadConcurrency: 1,
    });
    expect(outsideResponse.status).toBe(422);
    await expect(outsideResponse.json()).resolves.toMatchObject({
      error: { code: 'DOWNLOAD_ROOT_OUTSIDE_MOUNT' },
    });

    const unavailableResponse = await request('/settings', 'PUT', {
      downloadRoot: join(mountPath, 'missing'),
      globalCheckIntervalMinutes: 30,
      downloadConcurrency: 1,
    });
    expect(unavailableResponse.status).toBe(422);
    await expect(unavailableResponse.json()).resolves.toMatchObject({
      error: { code: 'DOWNLOAD_ROOT_UNAVAILABLE' },
    });

    database.close();
    const persistenceResponse = await request('/settings');
    expect(persistenceResponse.status).toBe(500);
    await expect(persistenceResponse.json()).resolves.toMatchObject({
      error: { code: 'PERSISTENCE_ERROR' },
    });
  });
});

describe('proxy API', () => {
  it('creates, lists, and fully updates a proxy without exposing credentials', async () => {
    const createResponse = await request('/proxies', 'POST', {
      name: 'office',
      protocol: 'http',
      host: 'proxy.example',
      port: 8080,
      username: 'user',
      password: 'secret',
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as {
      id: number;
      name: string;
      protocol: string;
      host: string;
      port: number;
      username: string | null;
      maskedPassword: string | null;
    };
    expect(created).toEqual({
      id: expect.any(Number),
      name: 'office',
      protocol: 'http',
      host: 'proxy.example',
      port: 8080,
      username: 'user',
      maskedPassword: 'se****',
    });

    const listResponse = await request('/proxies');
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual({ items: [created] });

    const updateResponse = await request(`/proxies/${created.id}`, 'PATCH', {
      name: 'home',
      protocol: 'socks5',
      host: 'localhost',
      port: 1080,
      username: 'user',
      password: 'new-secret',
    });
    expect(updateResponse.status).toBe(200);
    const responseText = await updateResponse.text();
    expect(JSON.parse(responseText)).toEqual({
      id: created.id,
      name: 'home',
      protocol: 'socks5',
      host: 'localhost',
      port: 1080,
      username: 'user',
      maskedPassword: 'ne********',
    });
    expect(responseText).not.toContain('new-secret');
    expect(responseText).not.toContain('user:');
  });

  it.each([
    [{ name: 'proxy' }],
    [{ name: 'proxy', url: 'http://proxy.example:8080' }],
    [{ name: 'proxy', protocol: 'http', host: 'proxy.example', port: 8080, username: null, password: null, extra: true }],
    [{ proxyName: 'proxy', protocol: 'http', host: 'proxy.example', port: 8080, username: null, password: null }],
  ])('rejects non-contract proxy create input %#', async (body) => {
    const response = await request('/proxies', 'POST', body);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_ERROR' },
    });
  });

  it('requires both fields on PATCH and rejects non-integer path IDs', async () => {
    const createdResponse = await request('/proxies', 'POST', {
      name: 'proxy',
      protocol: 'http',
      host: 'proxy.example',
      port: 8080,
      username: null,
      password: null,
    });
    const created = (await createdResponse.json()) as { id: number };

    const partialResponse = await request(
      `/proxies/${created.id}`,
      'PATCH',
      { name: 'renamed' },
    );
    expect(partialResponse.status).toBe(400);
    await expect(partialResponse.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_ERROR' },
    });

    for (const id of ['1.5', '1x', '01', '-1']) {
      const patchResponse = await request(`/proxies/${id}`, 'PATCH', {
        name: 'renamed',
        protocol: 'http',
        host: 'renamed.example',
        port: 8080,
        username: null,
        password: null,
      });
      expect(patchResponse.status).toBe(400);
      await expect(patchResponse.json()).resolves.toMatchObject({
        error: { code: 'VALIDATION_ERROR' },
      });

      const deleteResponse = await request(`/proxies/${id}`, 'DELETE');
      expect(deleteResponse.status).toBe(400);
      await expect(deleteResponse.json()).resolves.toMatchObject({
        error: { code: 'VALIDATION_ERROR' },
      });
    }
  });

  it('maps name conflicts and missing proxies', async () => {
    const firstResponse = await request('/proxies', 'POST', {
      name: 'first',
      protocol: 'http',
      host: 'first.example',
      port: 8080,
      username: null,
      password: null,
    });
    const first = (await firstResponse.json()) as { id: number };
    const secondResponse = await request('/proxies', 'POST', {
      name: 'second',
      protocol: 'http',
      host: 'second.example',
      port: 8080,
      username: null,
      password: null,
    });
    const second = (await secondResponse.json()) as { id: number };

    const createConflict = await request('/proxies', 'POST', {
      name: 'first',
      protocol: 'http',
      host: 'another.example',
      port: 8080,
      username: null,
      password: null,
    });
    expect(createConflict.status).toBe(409);
    await expect(createConflict.json()).resolves.toMatchObject({
      error: { code: 'PROXY_NAME_EXISTS' },
    });

    const updateConflict = await request(`/proxies/${second.id}`, 'PATCH', {
      name: 'first',
      protocol: 'http',
      host: 'second.example',
      port: 8080,
      username: null,
      password: null,
    });
    expect(updateConflict.status).toBe(409);
    await expect(updateConflict.json()).resolves.toMatchObject({
      error: { code: 'PROXY_NAME_EXISTS' },
    });

    const missingPatch = await request('/proxies/999', 'PATCH', {
      name: 'missing',
      protocol: 'http',
      host: 'missing.example',
      port: 8080,
      username: null,
      password: null,
    });
    expect(missingPatch.status).toBe(404);
    await expect(missingPatch.json()).resolves.toMatchObject({
      error: { code: 'PROXY_NOT_FOUND' },
    });

    const missingDelete = await request('/proxies/999', 'DELETE');
    expect(missingDelete.status).toBe(404);
    await expect(missingDelete.json()).resolves.toMatchObject({
      error: { code: 'PROXY_NOT_FOUND' },
    });
    expect(first.id).not.toBe(second.id);
  });

  it('deletes an unused proxy with no response body and rejects one in use', async () => {
    const unusedResponse = await request('/proxies', 'POST', {
      name: 'unused',
      protocol: 'http',
      host: 'unused.example',
      port: 8080,
      username: null,
      password: null,
    });
    const unused = (await unusedResponse.json()) as { id: number };
    const usedResponse = await request('/proxies', 'POST', {
      name: 'used',
      protocol: 'http',
      host: 'used.example',
      port: 8080,
      username: null,
      password: null,
    });
    const used = (await usedResponse.json()) as { id: number };

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

    const deleteResponse = await request(`/proxies/${unused.id}`, 'DELETE');
    expect(deleteResponse.status).toBe(204);
    expect(await deleteResponse.text()).toBe('');

    const inUseResponse = await request(`/proxies/${used.id}`, 'DELETE');
    expect(inUseResponse.status).toBe(409);
    await expect(inUseResponse.json()).resolves.toMatchObject({
      error: { code: 'PROXY_IN_USE' },
    });
  });
});
