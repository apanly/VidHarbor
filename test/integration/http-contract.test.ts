import type { AddressInfo } from 'node:net';

import { Router, type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { BusinessError } from '../../src/errors.js';

let baseUrl: string;
let stopServer: (() => Promise<void>) | undefined;
const languageCookies = [
  ['no Cookie (default zh-CN)', undefined],
  ['zh-CN', 'vidharbor_language=zh-CN'],
  ['en', 'vidharbor_language=en'],
  ['invalid', 'vidharbor_language=invalid'],
] as const;

function withLanguageCookie(
  headers: Record<string, string>,
  cookie: string | undefined,
): Record<string, string> {
  return cookie === undefined ? headers : { ...headers, cookie };
}

beforeEach(async () => {
  const api = Router();

  const echoJsonBody = (request: Request, response: Response) => {
    response.json(request.body);
  };
  api.post('/contract', echoJsonBody);
  api.put('/contract', echoJsonBody);
  api.patch('/contract', echoJsonBody);
  const echoCookieUpload = async (request: Request, response: Response) => {
    let size = 0;
    for await (const chunk of request) {
      size += Buffer.byteLength(chunk);
    }
    response.json({ size });
  };
  api.post('/authorizations/cookies/:platform', echoCookieUpload);
  api.put('/authorizations/cookies/:platform', echoCookieUpload);
  api.get('/business-error', () => {
    throw new BusinessError('VIDEO_FETCH_FAILED', 'video probe failed');
  });
  api.get('/database-error', () => {
    throw new BusinessError('PERSISTENCE_ERROR', 'database unavailable');
  });
  api.get('/unknown-error', () => {
    throw new Error('proxy password: top-secret');
  });

  const server = createApp(api).listen(0, '127.0.0.1');
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
});

async function postContract(
  body: unknown,
  cookie?: string,
): Promise<Response> {
  return fetch(`${baseUrl}/api/contract`, {
    method: 'POST',
    headers: withLanguageCookie(
      {
        'content-type': 'application/json',
        origin: baseUrl,
      },
      cookie,
    ),
    body: JSON.stringify(body),
  });
}

describe('HTTP contract', () => {
  it.each(languageCookies)(
    'serves API responses as UTF-8 JSON with %s',
    async (_, cookie) => {
      const response = await postContract(
        {
          count: null,
          ids: [1, 2],
          mode: 'batch',
        },
        cookie,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(
        'application/json; charset=utf-8',
      );
      expect(response.headers.has('content-language')).toBe(false);
      await expect(response.json()).resolves.toEqual({
        count: null,
        ids: [1, 2],
        mode: 'batch',
      });
    },
  );

  it('rejects a JSON write without the JSON media type', async () => {
    const response = await fetch(`${baseUrl}/api/contract`, {
      method: 'POST',
      headers: { origin: baseUrl },
      body: JSON.stringify({ count: 1, ids: [1], mode: 'single' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR' },
    });
  });

  it.each(languageCookies)(
    'passes Cookie uploads through as an unbuffered binary stream with %s',
    async (_, cookie) => {
      const body = 'raw-cookie-request-body';
      for (const method of ['POST', 'PUT'] as const) {
        const response = await fetch(
          `${baseUrl}/api/authorizations/cookies/youtube`,
          {
            method,
            headers: withLanguageCookie(
              {
                'content-type': 'application/octet-stream',
                origin: baseUrl,
              },
              cookie,
            ),
            body,
          },
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
          size: Buffer.byteLength(body),
        });
      }
    },
  );

  it.each([
    ['POST', '/api/contract'],
    ['PUT', '/api/contract'],
    ['PATCH', '/api/contract'],
    ['PATCH', '/api/authorizations/cookies/youtube'],
    ['PUT', '/api/authorizations/cookies'],
    ['PUT', '/api/authorizations/cookies/youtube/export'],
  ])(
    'keeps the JSON contract for %s %s',
    async (method, path) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/octet-stream',
          origin: baseUrl,
        },
        body: 'raw-body',
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'application/json required',
        },
      });
    },
  );

  it.each(languageCookies)(
    'rejects malformed JSON with the validation envelope with %s',
    async (_, cookie) => {
      const response = await fetch(`${baseUrl}/api/contract`, {
        method: 'POST',
        headers: withLanguageCookie(
          {
            'content-type': 'application/json',
            origin: baseUrl,
          },
          cookie,
        ),
        body: '{"count":',
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'invalid request body',
        },
      });
    },
  );

  it.each(languageCookies)(
    'rejects writes whose Origin is missing or not the current origin with %s',
    async (_, cookie) => {
      for (const origin of [
        undefined,
        'https://attacker.example',
        'http://127.0.0.1:1',
      ]) {
        const headers: Record<string, string> = withLanguageCookie(
          { 'content-type': 'application/json' },
          cookie,
        );
        if (origin !== undefined) headers.origin = origin;

        const response = await fetch(`${baseUrl}/api/contract`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ count: 1, ids: [1], mode: 'single' }),
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'invalid request origin',
          },
        });
      }
    },
  );

  it.each(languageCookies)(
    'maps defined business errors with %s',
    async (_, cookie) => {
      for (const [path, status, code, message] of [
        ['/business-error', 422, 'VIDEO_FETCH_FAILED', 'video probe failed'],
        ['/database-error', 500, 'PERSISTENCE_ERROR', 'database unavailable'],
      ] as const) {
        const response = await fetch(`${baseUrl}/api${path}`, {
          headers: withLanguageCookie({}, cookie),
        });

        expect(response.status).toBe(status);
        expect(response.headers.get('content-type')).toBe(
          'application/json; charset=utf-8',
        );
        expect(await response.json()).toEqual({ error: { code, message } });
      }
    },
  );

  it.each(languageCookies)(
    'maps unknown exceptions to a fixed secret-free error envelope with %s',
    async (_, cookie) => {
      const consoleError = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      try {
        const response = await fetch(`${baseUrl}/api/unknown-error`, {
          headers: withLanguageCookie({}, cookie),
        });
        const responseText = await response.text();

        expect(response.status).toBe(500);
        expect(JSON.parse(responseText)).toEqual({
          error: {
            code: 'PERSISTENCE_ERROR',
            message: 'internal server error',
          },
        });
        expect(responseText).not.toContain('top-secret');
        expect(responseText).not.toContain('at ');
        expect(consoleError).toHaveBeenCalledOnce();
        expect(consoleError).toHaveBeenCalledWith(
          JSON.stringify({
            event: 'api_internal_error',
            method: 'GET',
            path: '/unknown-error',
            errorClass: 'Error',
          }),
        );
        expect(consoleError.mock.calls.flat().join(' ')).not.toContain(
          'top-secret',
        );
        expect(consoleError.mock.calls.flat().join(' ')).not.toContain(
          'stack',
        );
      } finally {
        consoleError.mockRestore();
      }
    },
  );
});
