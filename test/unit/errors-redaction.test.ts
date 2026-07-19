import { describe, expect, it } from 'vitest';

import {
  BusinessError,
  getHttpStatus,
  toErrorResponse,
  type ErrorCode,
} from '../../src/errors.js';
import { redactProxyUrl, redactStderr } from '../../src/redaction.js';

describe('business errors', () => {
  it.each<[number, ErrorCode[]]>([
    [400, ['VALIDATION_ERROR']],
    [404, ['PROXY_NOT_FOUND', 'CHANNEL_NOT_FOUND', 'VIDEO_NOT_FOUND']],
    [
      409,
      [
        'PROXY_NAME_EXISTS',
        'PROXY_IN_USE',
        'CHANNEL_ALREADY_EXISTS',
        'CHANNEL_NAME_EXISTS',
        'CHANNEL_IN_USE',
        'DOWNLOAD_ALREADY_EXISTS',
      ],
    ],
    [
      422,
      [
        'DOWNLOAD_ROOT_OUTSIDE_MOUNT',
        'DOWNLOAD_ROOT_UNAVAILABLE',
        'DOWNLOAD_ROOT_NOT_CONFIGURED',
        'UNSUPPORTED_PLATFORM',
        'NOT_A_CHANNEL_URL',
        'NOT_A_VIDEO_URL',
        'GLOBAL_INTERVAL_NOT_CONFIGURED',
        'CHANNEL_FETCH_FAILED',
        'CHANNEL_METADATA_INVALID',
        'VIDEO_FETCH_FAILED',
        'VIDEO_METADATA_INVALID',
      ],
    ],
    [500, ['PERSISTENCE_ERROR']],
  ])('maps the defined error codes to HTTP %i', (status, codes) => {
    for (const code of codes) {
      expect(getHttpStatus(code)).toBe(status);
    }
  });

  it('returns the fixed API error shape', () => {
    const error = new BusinessError(
      'DOWNLOAD_ROOT_UNAVAILABLE',
      'download root is not writable',
    );

    expect(toErrorResponse(error)).toEqual({
      error: {
        code: 'DOWNLOAD_ROOT_UNAVAILABLE',
        message: 'download root is not writable',
      },
    });
  });

  it('rejects an undefined error code instead of exposing it', () => {
    expect(() => getHttpStatus('UNKNOWN_ERROR' as ErrorCode)).toThrow(
      'unknown error code: UNKNOWN_ERROR',
    );
  });
});

describe('proxy credential redaction', () => {
  it('redacts the complete userinfo while preserving the proxy endpoint', () => {
    expect(redactProxyUrl('http://alice:s3cret@proxy.example:8080')).toBe(
      'http://***@proxy.example:8080',
    );
    expect(redactProxyUrl('socks5h://alice@proxy.example:1080')).toBe(
      'socks5h://***@proxy.example:1080',
    );
  });

  it('returns a proxy URL without userinfo unchanged', () => {
    const proxyUrl = 'https://proxy.example:8443';

    expect(redactProxyUrl(proxyUrl)).toBe(proxyUrl);
  });

  it('replaces every known proxy URL in stderr', () => {
    const first = 'http://alice:s3cret@proxy.example:8080';
    const second = 'socks5://bob:password@backup.example:1080';
    const stderr = `failed ${first}; retry ${first}; fallback ${second}`;

    expect(redactStderr(stderr, [first, second])).toBe(
      'failed http://***@proxy.example:8080; retry http://***@proxy.example:8080; fallback socks5://***@backup.example:1080',
    );
  });

  it('replaces known raw proxy userinfo in stderr', () => {
    const proxyUrl = 'http://alice:s3cret@proxy.example:8080';

    expect(redactStderr('authentication failed for alice:s3cret', [proxyUrl])).toBe(
      'authentication failed for ***',
    );
  });

  it('redacts before truncating stderr to 4 KiB of UTF-8', () => {
    const proxyUrl = 'http://alice:s3cret@proxy.example:8080';
    const stderr = `${proxyUrl}${'界'.repeat(2000)}`;
    const result = redactStderr(stderr, [proxyUrl]);

    expect(result.startsWith('http://***@proxy.example:8080')).toBe(true);
    expect(result).not.toContain('alice');
    expect(result).not.toContain('s3cret');
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(4096);
  });
});
