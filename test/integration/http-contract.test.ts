import type { AddressInfo } from 'node:net';

import { Router, type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { BusinessError } from '../../src/errors.js';

let baseUrl: string;
let stopServer: (() => Promise<void>) | undefined;

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

async function postContract(body: unknown, origin = baseUrl): Promise<Response> {
  return fetch(`${baseUrl}/api/contract`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
    },
    body: JSON.stringify(body),
  });
}

describe('HTTP contract', () => {
  it('serves API responses as UTF-8 JSON', async () => {
    const response = await postContract({
      count: null,
      ids: [1, 2],
      mode: 'batch',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    );
    await expect(response.json()).resolves.toEqual({
      count: null,
      ids: [1, 2],
      mode: 'batch',
    });
  });

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

  it.each(['POST', 'PUT'] as const)(
    'passes %s Cookie uploads through as an unbuffered binary stream',
    async (method) => {
    const body = 'raw-cookie-request-body';
    const response = await fetch(
      `${baseUrl}/api/authorizations/cookies/youtube`,
      {
        method,
        headers: {
          'content-type': 'application/octet-stream',
          origin: baseUrl,
        },
        body,
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      size: Buffer.byteLength(body),
    });
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

  it('rejects malformed JSON with the validation envelope', async () => {
    const response = await fetch(`${baseUrl}/api/contract`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: baseUrl,
      },
      body: '{"count":',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'invalid request body',
      },
    });
  });

  it.each([undefined, 'https://attacker.example', 'http://127.0.0.1:1'])(
    'rejects a write whose Origin is missing or not the current origin',
    async (origin) => {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
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
    },
  );

  it.each([
    ['/business-error', 422, 'VIDEO_FETCH_FAILED', 'video probe failed'],
    ['/database-error', 500, 'PERSISTENCE_ERROR', 'database unavailable'],
  ] as const)(
    'maps defined business errors at %s',
    async (path, status, code, message) => {
      const response = await fetch(`${baseUrl}/api${path}`);

      expect(response.status).toBe(status);
      expect(response.headers.get('content-type')).toBe(
        'application/json; charset=utf-8',
      );
      expect(await response.json()).toEqual({ error: { code, message } });
    },
  );

  it('maps unknown exceptions to a fixed secret-free error envelope', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await fetch(`${baseUrl}/api/unknown-error`);
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
      expect(consoleError.mock.calls.flat().join(' ')).not.toContain('top-secret');
      expect(consoleError.mock.calls.flat().join(' ')).not.toContain('stack');
    } finally {
      consoleError.mockRestore();
    }
  });
});
