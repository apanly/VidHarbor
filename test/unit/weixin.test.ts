import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const httpMocks = vi.hoisted(() => {
  interface QueuedResponse {
    readonly statusCode?: number;
    readonly body?: string;
    readonly requestError?: boolean;
    readonly responseError?: boolean;
    readonly timeout?: boolean;
  }

  interface RequestRecord {
    readonly endpoint: URL;
    readonly options: Record<string, unknown>;
    body: string;
  }

  const queued: QueuedResponse[] = [];
  const requests: RequestRecord[] = [];
  const proxyAgents: Array<{
    readonly options: { readonly getProxyForUrl: () => string };
    readonly destroy: ReturnType<typeof vi.fn>;
  }> = [];

  class ProxyAgent {
    readonly destroy = vi.fn();

    constructor(
      readonly options: { readonly getProxyForUrl: () => string },
    ) {
      proxyAgents.push(this);
    }
  }

  const request = vi.fn(
    (
      endpoint: URL,
      options: Record<string, unknown>,
      onResponse: (response: {
        readonly statusCode: number | undefined;
        on: (event: string, listener: (value?: string) => void) => void;
      }) => void,
    ) => {
      const listeners = new Map<string, Array<() => void>>();
      let timeoutListener: (() => void) | undefined;
      const record: RequestRecord = { endpoint, options, body: '' };
      requests.push(record);

      const fakeRequest = {
        setTimeout: vi.fn((_milliseconds: number, listener: () => void) => {
          timeoutListener = listener;
        }),
        destroy: vi.fn(),
        on: vi.fn((event: string, listener: () => void) => {
          const eventListeners = listeners.get(event) ?? [];
          eventListeners.push(listener);
          listeners.set(event, eventListeners);
          return fakeRequest;
        }),
        end: vi.fn((body: string) => {
          record.body = body;
          const next = queued.shift();
          if (next === undefined) throw new Error('missing queued response');
          queueMicrotask(() => {
            if (next.timeout === true) {
              timeoutListener?.();
              return;
            }
            if (
              next.requestError === true ||
              (options.signal as AbortSignal | undefined)?.aborted === true
            ) {
              for (const listener of listeners.get('error') ?? []) listener();
              return;
            }

            const responseListeners = new Map<
              string,
              Array<(value?: string) => void>
            >();
            onResponse({
              statusCode: next.statusCode,
              on(event, listener) {
                const eventListeners = responseListeners.get(event) ?? [];
                eventListeners.push(listener);
                responseListeners.set(event, eventListeners);
              },
            });
            queueMicrotask(() => {
              if (next.responseError === true) {
                for (const listener of responseListeners.get('error') ?? []) {
                  listener();
                }
                return;
              }
              if (next.body !== undefined) {
                for (const listener of responseListeners.get('data') ?? []) {
                  listener(next.body);
                }
              }
              for (const listener of responseListeners.get('end') ?? []) {
                listener();
              }
            });
          });
        }),
      };
      return fakeRequest;
    },
  );

  return { ProxyAgent, proxyAgents, queued, request, requests };
});

vi.mock('node:https', () => ({ request: httpMocks.request }));
vi.mock('proxy-agent', () => ({ ProxyAgent: httpMocks.ProxyAgent }));

import { BusinessError } from '../../src/errors.js';
import {
  isWeixinVideoHost,
  parseWeixinShareUrl,
  resolveWeixinVideo,
} from '../../src/weixin.js';

const SHARE_URL = 'https://weixin.qq.com/sph/AVIerfY9nv';
const FUTURE_EXPIRY = '4102444800';
const COOKIE_SECRET = 'cookie-secret';
const PROXY_URL = 'http://alice:proxy-secret@proxy.example:8080';

let sandbox: string;
let cookieFilePath: string;

function cookieLine(
  domain: string,
  includeSubdomains: 'TRUE' | 'FALSE',
  path: string,
  secure: 'TRUE' | 'FALSE',
  expires: string,
  name: string,
  value: string,
): string {
  return [domain, includeSubdomains, path, secure, expires, name, value].join(
    '\t',
  );
}

function queueJson(value: unknown, statusCode = 200): void {
  httpMocks.queued.push({ statusCode, body: JSON.stringify(value) });
}

function queueParseResponse(
  playableUrl = 'https://example.test/play?token=token-secret&eid=eid-secret',
): void {
  queueJson({ data: { playable_url: playableUrl } });
}

function feedResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    data: {
      feedInfo: {
        description: 'A video title',
        videoUrl: 'https://media.example/video.mp4',
        h264VideoInfo: { videoUrl: 'https://media.example/fallback.mp4' },
        ...overrides,
      },
      authorInfo: { nickname: 'Video author' },
    },
  };
}

async function saveDefaultCookie(): Promise<void> {
  await writeFile(
    cookieFilePath,
    `${cookieLine('yuanbao.tencent.com', 'FALSE', '/', 'TRUE', FUTURE_EXPIRY, 'session', COOKIE_SECRET)}\n`,
  );
}

async function expectBusinessError(
  operation: Promise<unknown>,
  code: BusinessError['code'],
): Promise<BusinessError> {
  try {
    await operation;
    throw new Error('expected BusinessError');
  } catch (error) {
    expect(error).toBeInstanceOf(BusinessError);
    expect(error).toMatchObject({ code });
    return error as BusinessError;
  }
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'vidharbor-weixin-'));
  cookieFilePath = join(sandbox, 'yuanbao.cookies.txt');
  httpMocks.queued.length = 0;
  httpMocks.requests.length = 0;
  httpMocks.proxyAgents.length = 0;
  httpMocks.request.mockClear();
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('Weixin URL contract', () => {
  it('returns the archive-safe short ID from the exact share URL', () => {
    expect(parseWeixinShareUrl(SHARE_URL)).toBe('AVIerfY9nv');
  });

  it.each([
    'http://weixin.qq.com/sph/AVIerfY9nv',
    'https://WEIXIN.qq.com/sph/AVIerfY9nv',
    'https://weixin.qq.com:443/sph/AVIerfY9nv',
    'https://weixin.qq.com/sph/AVIerfY9nv/',
    'https://weixin.qq.com/sph/AVIerfY9nv/extra',
    'https://weixin.qq.com/sph/AVIerfY9nv?from=share',
    'https://weixin.qq.com/sph/AVIerfY9nv#fragment',
    'https://weixin.qq.com/sph/not.valid',
    'https://weixin.qq.com/sph/%41VIerfY9nv',
    'https://channels.weixin.qq.com/sph/AVIerfY9nv',
    'not a URL',
  ])('rejects the non-contract share URL %s', (value) => {
    expect(() => parseWeixinShareUrl(value)).toThrowError(
      expect.objectContaining({ code: 'NOT_A_VIDEO_URL' }),
    );
  });

  it('recognizes only the two exact Weixin video hosts', () => {
    expect(isWeixinVideoHost(SHARE_URL)).toBe(true);
    expect(
      isWeixinVideoHost(
        'https://channels.weixin.qq.com/finder-preview/video.html',
      ),
    ).toBe(true);
    expect(isWeixinVideoHost('https://sub.weixin.qq.com/sph/id')).toBe(false);
    expect(isWeixinVideoHost('https://weixin.qq.com.example/sph/id')).toBe(false);
    expect(isWeixinVideoHost('not a URL')).toBe(false);
  });
});

describe('resolveWeixinVideo transport', () => {
  it('filters Netscape cookies and sends the two exact direct requests', async () => {
    const abortController = new AbortController();
    await writeFile(
      cookieFilePath,
      [
        '# Netscape HTTP Cookie File',
        cookieLine(
          '.tencent.com',
          'TRUE',
          '/',
          'TRUE',
          FUTURE_EXPIRY,
          'session',
          COOKIE_SECRET,
        ),
        cookieLine(
          'yuanbao.tencent.com',
          'FALSE',
          '/api/weixin/',
          'TRUE',
          FUTURE_EXPIRY,
          'scoped',
          'scope-value',
        ),
        cookieLine(
          '#HttpOnly_.yuanbao.tencent.com',
          'TRUE',
          '/',
          'TRUE',
          FUTURE_EXPIRY,
          'httpOnly',
          'http-only-value',
        ),
        cookieLine(
          'yuanbao.tencent.com',
          'FALSE',
          '/',
          'FALSE',
          FUTURE_EXPIRY,
          'plain',
          'plain-value',
        ),
        cookieLine(
          'other.tencent.com',
          'FALSE',
          '/',
          'TRUE',
          FUTURE_EXPIRY,
          'wrongDomain',
          'excluded',
        ),
        cookieLine(
          'yuanbao.tencent.com',
          'FALSE',
          '/other',
          'TRUE',
          FUTURE_EXPIRY,
          'wrongPath',
          'excluded',
        ),
        cookieLine(
          'yuanbao.tencent.com',
          'FALSE',
          '/',
          'TRUE',
          '1',
          'expired',
          'excluded',
        ),
      ].join('\r\n'),
    );
    queueParseResponse('https://play.example/path?token=tok%2Ben&eid=eid-1');
    queueJson(feedResponse());

    await expect(
      resolveWeixinVideo({
        shareUrl: SHARE_URL,
        cookieFilePath,
        signal: abortController.signal,
      }),
    ).resolves.toEqual({
      platform: 'weixin',
      platformVideoId: 'AVIerfY9nv',
      title: 'A video title',
      authorNickname: 'Video author',
      videoUrl: 'https://media.example/video.mp4',
    });

    expect(httpMocks.requests).toHaveLength(2);
    const [parseRequest, feedRequest] = httpMocks.requests;
    expect(parseRequest?.endpoint.href).toBe(
      'https://yuanbao.tencent.com/api/weixin/get_parse_result',
    );
    expect(parseRequest?.options).toEqual({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie:
          'session=cookie-secret; scoped=scope-value; httpOnly=http-only-value; plain=plain-value',
      },
      signal: abortController.signal,
    });
    expect(parseRequest?.body).toBe(
      `{"type":"video_channel_url","url":"${SHARE_URL}","scene":1}`,
    );
    expect(feedRequest?.endpoint.href).toBe(
      'https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info',
    );
    expect(feedRequest?.options).toEqual({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://channels.weixin.qq.com',
        Referer: 'https://channels.weixin.qq.com/finder-preview/pages/feed',
      },
      signal: abortController.signal,
    });
    expect(feedRequest?.body).toBe(
      '{"baseReq":{"generalToken":"tok+en"},"exportId":"eid-1"}',
    );
    expect(httpMocks.proxyAgents).toHaveLength(0);
  });

  it('uses the confirmed H.264 video address when the direct field is absent', async () => {
    await saveDefaultCookie();
    queueParseResponse();
    queueJson(
      feedResponse({
        videoUrl: undefined,
        h264VideoInfo: { videoUrl: 'https://media.example/h264.mp4' },
      }),
    );

    await expect(
      resolveWeixinVideo({ shareUrl: SHARE_URL, cookieFilePath }),
    ).resolves.toMatchObject({
      videoUrl: 'https://media.example/h264.mp4',
    });
  });

  it.each([
    'http://proxy.example:8080',
    'https://proxy.example:8443',
    'socks5://proxy.example:1080',
  ])('uses one fixed ProxyAgent for both requests through %s', async (proxyUrl) => {
    await saveDefaultCookie();
    queueParseResponse();
    queueJson(feedResponse());

    await resolveWeixinVideo({ shareUrl: SHARE_URL, cookieFilePath, proxyUrl });

    expect(httpMocks.proxyAgents).toHaveLength(1);
    const proxyAgent = httpMocks.proxyAgents[0]!;
    expect(proxyAgent.options.getProxyForUrl()).toBe(proxyUrl);
    expect(httpMocks.requests[0]?.options.agent).toBe(proxyAgent);
    expect(httpMocks.requests[1]?.options.agent).toBe(proxyAgent);
    expect(proxyAgent.destroy).toHaveBeenCalledOnce();
  });

  it('passes the fixed 30 second timeout to every request', async () => {
    await saveDefaultCookie();
    queueParseResponse();
    queueJson(feedResponse());

    await resolveWeixinVideo({ shareUrl: SHARE_URL, cookieFilePath });

    for (const result of httpMocks.request.mock.results) {
      expect(result.value.setTimeout).toHaveBeenCalledWith(
        30_000,
        expect.any(Function),
      );
    }
  });
});

describe('resolveWeixinVideo failure boundaries', () => {
  it('fails before transport when no Cookie matches the Yuanbao endpoint', async () => {
    await writeFile(
      cookieFilePath,
      [
        cookieLine(
          'other.example',
          'FALSE',
          '/',
          'TRUE',
          FUTURE_EXPIRY,
          'foreign',
          COOKIE_SECRET,
        ),
        cookieLine(
          'yuanbao.tencent.com',
          'FALSE',
          '/',
          'TRUE',
          '1',
          'expired',
          COOKIE_SECRET,
        ),
      ].join('\n'),
    );

    await expectBusinessError(
      resolveWeixinVideo({ shareUrl: SHARE_URL, cookieFilePath }),
      'VIDEO_FETCH_FAILED',
    );
    expect(httpMocks.requests).toHaveLength(0);
  });

  it('rejects a changed non-seven-field Cookie file', async () => {
    await writeFile(cookieFilePath, 'yuanbao.tencent.com\tbroken\n');

    await expectBusinessError(
      resolveWeixinVideo({ shareUrl: SHARE_URL, cookieFilePath }),
      'VIDEO_METADATA_INVALID',
    );
  });

  it('maps a non-2xx response to a fetch failure without exposing its body', async () => {
    await saveDefaultCookie();
    httpMocks.queued.push({
      statusCode: 401,
      body: `session invalid: ${COOKIE_SECRET}`,
    });

    const error = await expectBusinessError(
      resolveWeixinVideo({ shareUrl: SHARE_URL, cookieFilePath }),
      'VIDEO_FETCH_FAILED',
    );
    expect(error.message).not.toContain(COOKIE_SECRET);
    expect(error.message).not.toContain('session invalid');
  });

  it('maps a network error to a fetch failure', async () => {
    await saveDefaultCookie();
    httpMocks.queued.push({ requestError: true });

    await expectBusinessError(
      resolveWeixinVideo({ shareUrl: SHARE_URL, cookieFilePath }),
      'VIDEO_FETCH_FAILED',
    );
  });

  it('maps a request timeout to a fetch failure', async () => {
    await saveDefaultCookie();
    httpMocks.queued.push({ timeout: true });

    await expectBusinessError(
      resolveWeixinVideo({ shareUrl: SHARE_URL, cookieFilePath }),
      'VIDEO_FETCH_FAILED',
    );
  });

  it('passes an already aborted signal into the request failure boundary', async () => {
    await saveDefaultCookie();
    httpMocks.queued.push({ statusCode: 200, body: '{}' });
    const abortController = new AbortController();
    abortController.abort();

    await expectBusinessError(
      resolveWeixinVideo({
        shareUrl: SHARE_URL,
        cookieFilePath,
        signal: abortController.signal,
      }),
      'VIDEO_FETCH_FAILED',
    );
  });

  it('rejects a non-JSON response as invalid metadata', async () => {
    await saveDefaultCookie();
    httpMocks.queued.push({ statusCode: 200, body: '<html>not JSON</html>' });

    await expectBusinessError(
      resolveWeixinVideo({ shareUrl: SHARE_URL, cookieFilePath }),
      'VIDEO_METADATA_INVALID',
    );
  });

  it.each([
    ['missing token', 'https://play.example/path?eid=eid-secret'],
    ['missing eid', 'https://play.example/path?token=token-secret'],
    [
      'duplicate token',
      'https://play.example/path?token=one&token=two&eid=eid-secret',
    ],
    [
      'duplicate eid',
      'https://play.example/path?token=token-secret&eid=one&eid=two',
    ],
    [
      'unsupported exportId alias',
      'https://play.example/path?token=token-secret&exportId=eid-secret',
    ],
    [
      'blank token',
      'https://play.example/path?token=%20&eid=eid-secret',
    ],
  ])('rejects playable_url with %s', async (_name, playableUrl) => {
    await saveDefaultCookie();
    queueParseResponse(playableUrl);

    await expectBusinessError(
      resolveWeixinVideo({ shareUrl: SHARE_URL, cookieFilePath }),
      'VIDEO_METADATA_INVALID',
    );
    expect(httpMocks.requests).toHaveLength(1);
  });

  it.each([
    [
      'missing title',
      {
        data: {
          feedInfo: { videoUrl: 'https://media.example/video.mp4' },
          authorInfo: { nickname: 'Author' },
        },
      },
    ],
    [
      'missing author nickname',
      {
        data: {
          feedInfo: {
            description: 'Title',
            videoUrl: 'https://media.example/video.mp4',
          },
          authorInfo: {},
        },
      },
    ],
    [
      'image-only payload',
      {
        data: {
          feedInfo: { description: 'Title', images: ['image'] },
          authorInfo: { nickname: 'Author' },
        },
      },
    ],
    [
      'live-only payload',
      {
        data: {
          feedInfo: { description: 'Title', liveInfo: { url: 'live' } },
          authorInfo: { nickname: 'Author' },
        },
      },
    ],
    [
      'H.265-only payload',
      {
        data: {
          feedInfo: {
            description: 'Title',
            h265VideoInfo: { videoUrl: 'https://media.example/h265.mp4' },
          },
          authorInfo: { nickname: 'Author' },
        },
      },
    ],
  ])('rejects a feed response with %s', async (_name, response) => {
    await saveDefaultCookie();
    queueParseResponse();
    queueJson(response);

    await expectBusinessError(
      resolveWeixinVideo({ shareUrl: SHARE_URL, cookieFilePath }),
      'VIDEO_METADATA_INVALID',
    );
  });

  it('rejects a malformed preferred video field instead of using a fallback', async () => {
    await saveDefaultCookie();
    queueParseResponse();
    queueJson(
      feedResponse({
        videoUrl: 42,
        h264VideoInfo: { videoUrl: 'https://media.example/fallback.mp4' },
      }),
    );

    await expectBusinessError(
      resolveWeixinVideo({ shareUrl: SHARE_URL, cookieFilePath }),
      'VIDEO_METADATA_INVALID',
    );
  });

  it('rejects a non-HTTPS video URL without exposing sensitive values', async () => {
    await saveDefaultCookie();
    queueParseResponse();
    queueJson(feedResponse({ videoUrl: 'http://media.example/video.mp4' }));

    const error = await expectBusinessError(
      resolveWeixinVideo({
        shareUrl: SHARE_URL,
        cookieFilePath,
        proxyUrl: PROXY_URL,
      }),
      'VIDEO_METADATA_INVALID',
    );
    expect(error.message).not.toContain(COOKIE_SECRET);
    expect(error.message).not.toContain('token-secret');
    expect(error.message).not.toContain('eid-secret');
    expect(error.message).not.toContain('alice');
    expect(error.message).not.toContain('proxy-secret');
    expect(error.message).not.toContain('http://media.example/video.mp4');
  });
});
