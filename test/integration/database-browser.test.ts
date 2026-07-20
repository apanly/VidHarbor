import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApiRouter, createApp } from '../../src/app.js';
import { openDatabase, type DatabaseConnection } from '../../src/db/client.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { RuntimeCoordinator } from '../../src/runtime.js';
import type { DownloadQueue } from '../../src/services/download.js';

let sandbox: string;
let database: DatabaseConnection;
let baseUrl: string;
let stopServer: () => Promise<void>;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'vidharbor-database-browser-'));
  const downloadsMountPath = join(sandbox, 'downloads');
  await mkdir(downloadsMountPath);
  database = openDatabase(join(sandbox, 'vidharbor.sqlite'));
  migrateDatabase(database);

  const queue: DownloadQueue = { enqueue: () => undefined };
  const app = createApp(
    createApiRouter(
      database,
      downloadsMountPath,
      new RuntimeCoordinator(() => undefined),
      'unused-yt-dlp',
      queue,
    ),
  );
  app.set('views', new URL('../../src/views', import.meta.url).pathname);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  stopServer = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
});

afterEach(async () => {
  await stopServer();
  database.close();
  await rm(sandbox, { recursive: true, force: true });
});

async function query(sql: string): Promise<Response> {
  return fetch(`${baseUrl}/api/database/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ sql }),
  });
}

describe('database browser', () => {
  it('renders the database page and navigation entry', async () => {
    const response = await fetch(`${baseUrl}/database`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('<h1>数据库</h1>');
    expect(html).toContain('id="database-query-form"');
    expect(html).toContain('class="sidebar-link active" href="/database">数据库</a>');
    expect(html).toContain('<script type="module" src="/public/database.js"></script>');
  });

  it('lists tables and returns readonly query results as columns and row arrays', async () => {
    const tablesResponse = await fetch(`${baseUrl}/api/database/tables`);
    expect(await tablesResponse.json()).toMatchObject({
      tables: expect.arrayContaining(['channels', 'downloads', 'settings']),
    });

    const response = await query('SELECT id, download_concurrency FROM settings');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      columns: ['id', 'download_concurrency'],
      rows: [[1, 1]],
      rowCount: 1,
    });
  });

  it('rejects missing, invalid, and write SQL without changing the database', async () => {
    const missing = await query('');
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'sql is required' },
    });

    const invalid = await query('SELECT FROM');
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR' },
    });

    const write = await query('CREATE TABLE forbidden (id INTEGER)');
    expect(write.status).toBe(400);
    expect(await write.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'only readonly SQL is supported',
      },
    });
    expect(
      database
        .prepare("SELECT COUNT(*) FROM sqlite_schema WHERE name = 'forbidden'")
        .pluck()
        .get(),
    ).toBe(0);
  });
});
