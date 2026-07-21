import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Router } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { createAuthorizationsRouter } from '../../src/routes/authorizations.js';
import { CookieAuthorizationService } from '../../src/services/cookie-authorization.js';

const SENSITIVE_MARKER = 'cookie-api-sensitive-marker';
const VALID_COOKIE =
  `.example.test\tTRUE\t/\tFALSE\t0\tsession\t${SENSITIVE_MARKER}\n`;

const sandboxes: string[] = [];
const stopServers: Array<() => Promise<void>> = [];
let baseUrl: string;
let storage: string;
let service: CookieAuthorizationService;

async function startApi(
  cookieAuthorizationService: CookieAuthorizationService,
): Promise<string> {
  const api = Router();
  api.use(
    '/authorizations',
    createAuthorizationsRouter(cookieAuthorizationService),
  );
  const server = createApp(api).listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  stopServers.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  );
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function writeRequest(
  path: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body?: string,
  contentType = 'application/octet-stream',
  origin = baseUrl,
): Promise<Response> {
  const headers: Record<string, string> = { origin };
  if (body !== undefined) headers['content-type'] = contentType;
  return await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body,
  });
}

beforeEach(async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'vidharbor-cookie-api-'));
  sandboxes.push(sandbox);
  storage = join(sandbox, 'cookies');
  service = new CookieAuthorizationService(storage);
  await service.initialize();
  baseUrl = await startApi(service);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stopServers.splice(0).map((stop) => stop()));
  await Promise.all(
    sandboxes.splice(0).map((sandbox) =>
      rm(sandbox, { recursive: true, force: true }),
    ),
  );
});

describe('Cookie authorization API', () => {
  it('lists only configured platforms with public metadata', async () => {
    const response = await fetch(
      `${baseUrl}/api/authorizations/cookies`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ configurations: [] });
  });

  it('uploads, replaces, rebuilds, and deletes one platform without exposing content', async () => {
    const upload = await writeRequest(
      '/api/authorizations/cookies/youtube',
      'POST',
      VALID_COOKIE,
    );
    const uploadText = await upload.text();

    expect(upload.status).toBe(200);
    const uploaded = JSON.parse(uploadText) as {
      configuration: Record<string, unknown>;
    };
    expect(Object.keys(uploaded.configuration).sort()).toEqual([
      'configured',
      'platform',
      'updatedAt',
    ]);
    expect(uploaded.configuration).toMatchObject({
      platform: 'youtube',
      configured: true,
    });
    expect(typeof uploaded.configuration.updatedAt).toBe('string');
    expect(uploadText.includes(SENSITIVE_MARKER)).toBe(false);

    const duplicate = await writeRequest(
      '/api/authorizations/cookies/youtube',
      'POST',
      VALID_COOKIE,
    );
    expect(duplicate.status).toBe(400);
    await expect(duplicate.json()).resolves.toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'cookie configuration already exists',
      },
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const replacement = await writeRequest(
      '/api/authorizations/cookies/youtube',
      'PUT',
      VALID_COOKIE.replace('session', 'replacement'),
    );
    const replacementBody = (await replacement.json()) as {
      configuration: { updatedAt: string };
    };
    expect(replacement.status).toBe(200);
    expect(replacementBody.configuration.updatedAt).not.toBe(
      uploaded.configuration.updatedAt,
    );

    const rebuiltService = new CookieAuthorizationService(storage);
    await rebuiltService.initialize();
    const rebuiltBaseUrl = await startApi(rebuiltService);
    const rebuiltResponse = await fetch(
      `${rebuiltBaseUrl}/api/authorizations/cookies`,
    );
    const rebuiltText = await rebuiltResponse.text();
    expect(rebuiltResponse.status).toBe(200);
    expect(
      (
        JSON.parse(rebuiltText) as {
          configurations: Array<Record<string, unknown>>;
        }
      ).configurations[0],
    ).toEqual({
      platform: 'youtube',
      configured: true,
      updatedAt: replacementBody.configuration.updatedAt,
    });
    expect(rebuiltText.includes(SENSITIVE_MARKER)).toBe(false);

    const deleteResponse = await fetch(
      `${rebuiltBaseUrl}/api/authorizations/cookies/youtube`,
      {
        method: 'DELETE',
        headers: { origin: rebuiltBaseUrl },
      },
    );
    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({
      configuration: {
        platform: 'youtube',
        configured: false,
        updatedAt: null,
      },
    });
  });

  it.each([
    [
      'unknown upload platform',
      '/api/authorizations/cookies/vimeo',
      'POST',
      VALID_COOKIE,
      'application/octet-stream',
      undefined,
      'invalid cookie platform',
    ],
    [
      'unknown delete platform',
      '/api/authorizations/cookies/twitter',
      'DELETE',
      undefined,
      'application/octet-stream',
      undefined,
      'invalid cookie platform',
    ],
    [
      'wrong upload media type',
      '/api/authorizations/cookies/youtube',
      'POST',
      VALID_COOKIE,
      'application/json',
      undefined,
      'application/octet-stream required',
    ],
    [
      'empty upload',
      '/api/authorizations/cookies/youtube',
      'POST',
      '',
      'application/octet-stream',
      undefined,
      'cookie file is empty',
    ],
    [
      'invalid Netscape upload',
      '/api/authorizations/cookies/youtube',
      'POST',
      'not-a-cookie-file',
      'application/octet-stream',
      undefined,
      'invalid Netscape cookie file',
    ],
    [
      'unconfigured delete',
      '/api/authorizations/cookies/youtube',
      'DELETE',
      undefined,
      'application/octet-stream',
      undefined,
      'cookie configuration is not configured',
    ],
    [
      'unconfigured edit',
      '/api/authorizations/cookies/youtube',
      'PUT',
      VALID_COOKIE,
      'application/octet-stream',
      undefined,
      'cookie configuration is not configured',
    ],
    [
      'cross-origin upload',
      '/api/authorizations/cookies/youtube',
      'POST',
      VALID_COOKIE,
      'application/octet-stream',
      'https://attacker.example',
      'invalid request origin',
    ],
    [
      'cross-origin delete',
      '/api/authorizations/cookies/youtube',
      'DELETE',
      undefined,
      'application/octet-stream',
      'https://attacker.example',
      'invalid request origin',
    ],
  ] as const)(
    'rejects %s with the fixed validation contract',
    async (_name, path, method, body, contentType, origin, message) => {
      const response = await writeRequest(
        path,
        method,
        body,
        contentType,
        origin,
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: { code: 'VALIDATION_ERROR', message },
      });
    },
  );

  it('maps filesystem failures to one secret-free persistence error without logging content', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const loggedErrors = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    await rm(storage, { recursive: true });
    await writeFile(storage, 'not-a-directory');

    const responses = await Promise.all([
      fetch(`${baseUrl}/api/authorizations/cookies`),
      writeRequest(
        '/api/authorizations/cookies/youtube',
        'POST',
        VALID_COOKIE,
      ),
      writeRequest(
        '/api/authorizations/cookies/youtube',
        'DELETE',
      ),
    ]);

    for (const response of responses) {
      const text = await response.text();
      expect(response.status).toBe(500);
      expect(JSON.parse(text)).toEqual({
        error: {
          code: 'PERSISTENCE_ERROR',
          message: 'cookie persistence failed',
        },
      });
      expect(text.includes(SENSITIVE_MARKER)).toBe(false);
      expect(text.includes(storage)).toBe(false);
    }
    const logs = JSON.stringify([logged.mock.calls, loggedErrors.mock.calls]);
    expect(logs.includes(SENSITIVE_MARKER)).toBe(false);
    expect(logs.includes(storage)).toBe(false);
  });

  it('does not provide Cookie content or arbitrary mutation routes', async () => {
    const responses = await Promise.all([
      fetch(`${baseUrl}/api/authorizations/cookies/youtube`),
      fetch(`${baseUrl}/api/authorizations/cookies/youtube/download`),
      fetch(`${baseUrl}/api/authorizations/cookies`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: baseUrl,
        },
        body: '{}',
      }),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([404, 404, 404]);
  });
});
