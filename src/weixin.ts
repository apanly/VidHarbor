import { readFile } from 'node:fs/promises';
import * as https from 'node:https';

import { ProxyAgent } from 'proxy-agent';

import { BusinessError } from './errors.js';
import { isArchiveVideoId } from './filesystem.js';

const YUANBAO_ENDPOINT = new URL(
  'https://yuanbao.tencent.com/api/weixin/get_parse_result',
);
const WEIXIN_FEED_ENDPOINT = new URL(
  'https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info',
);
const REQUEST_TIMEOUT_MILLISECONDS = 30_000;
const FETCH_FAILED_MESSAGE = 'Weixin video fetch failed';
const METADATA_INVALID_MESSAGE = 'Weixin video metadata is invalid';
const HTTP_ONLY_PREFIX = '#HttpOnly_';

export interface ResolveWeixinVideoOptions {
  readonly shareUrl: string;
  readonly cookieFilePath: string;
  readonly proxyUrl?: string;
  readonly signal?: AbortSignal;
}

export interface ResolvedWeixinVideo {
  readonly platform: 'weixin';
  readonly platformVideoId: string;
  readonly title: string;
  readonly authorNickname: string;
  readonly videoUrl: string;
}

interface NetscapeCookie {
  readonly domain: string;
  readonly includeSubdomains: boolean;
  readonly path: string;
  readonly secure: boolean;
  readonly expires: bigint;
  readonly name: string;
  readonly value: string;
}

function metadataInvalid(): BusinessError {
  return new BusinessError('VIDEO_METADATA_INVALID', METADATA_INVALID_MESSAGE);
}

function fetchFailed(): BusinessError {
  return new BusinessError('VIDEO_FETCH_FAILED', FETCH_FAILED_MESSAGE);
}

export function isWeixinVideoHost(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === 'weixin.qq.com' || host === 'channels.weixin.qq.com';
  } catch {
    return false;
  }
}

export function parseWeixinShareUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BusinessError('NOT_A_VIDEO_URL', 'not a Weixin video URL');
  }

  const prefix = '/sph/';
  const videoId = url.pathname.startsWith(prefix)
    ? url.pathname.slice(prefix.length)
    : '';
  if (
    url.href !== value ||
    url.protocol !== 'https:' ||
    url.hostname !== 'weixin.qq.com' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !isArchiveVideoId(videoId)
  ) {
    throw new BusinessError('NOT_A_VIDEO_URL', 'not a Weixin video URL');
  }

  return videoId;
}

function parseCookieLine(line: string): NetscapeCookie {
  const fields = line.split('\t');
  if (fields.length !== 7) throw metadataInvalid();

  const [rawDomain, rawIncludeSubdomains, path, rawSecure, rawExpires, name, value] =
    fields as [string, string, string, string, string, string, string];
  const domain = rawDomain.startsWith(HTTP_ONLY_PREFIX)
    ? rawDomain.slice(HTTP_ONLY_PREFIX.length)
    : rawDomain;
  if (
    domain === '' ||
    path === '' ||
    name === '' ||
    (rawIncludeSubdomains !== 'TRUE' && rawIncludeSubdomains !== 'FALSE') ||
    (rawSecure !== 'TRUE' && rawSecure !== 'FALSE') ||
    !/^\d+$/u.test(rawExpires)
  ) {
    throw metadataInvalid();
  }

  return {
    domain,
    includeSubdomains: rawIncludeSubdomains === 'TRUE',
    path,
    secure: rawSecure === 'TRUE',
    expires: BigInt(rawExpires),
    name,
    value,
  };
}

function domainMatches(cookie: NetscapeCookie, host: string): boolean {
  const domain = cookie.domain.startsWith('.')
    ? cookie.domain.slice(1)
    : cookie.domain;
  if (domain === '') return false;
  const normalizedDomain = domain.toLowerCase();
  const normalizedHost = host.toLowerCase();
  if (normalizedHost === normalizedDomain) return true;
  return (
    cookie.includeSubdomains &&
    normalizedHost.endsWith(`.${normalizedDomain}`)
  );
}

function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (!requestPath.startsWith(cookiePath)) return false;
  return (
    requestPath.length === cookiePath.length ||
    cookiePath.endsWith('/') ||
    requestPath[cookiePath.length] === '/'
  );
}

function cookiesForEndpoint(contents: string, endpoint: URL): string {
  if (contents.replaceAll('\r\n', '').includes('\r')) throw metadataInvalid();

  const now = BigInt(Math.floor(Date.now() / 1000));
  const cookies: string[] = [];
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (
      line.trim() === '' ||
      (line.startsWith('#') && !line.startsWith(HTTP_ONLY_PREFIX))
    ) {
      continue;
    }

    const cookie = parseCookieLine(line);
    if (
      domainMatches(cookie, endpoint.hostname) &&
      pathMatches(cookie.path, endpoint.pathname) &&
      (!cookie.secure || endpoint.protocol === 'https:') &&
      (cookie.expires === 0n || cookie.expires > now)
    ) {
      cookies.push(`${cookie.name}=${cookie.value}`);
    }
  }

  if (cookies.length === 0) throw fetchFailed();
  return cookies.join('; ');
}

function postJson(
  endpoint: URL,
  body: string,
  cookieHeader: string | undefined,
  agent: ProxyAgent | undefined,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (cookieHeader !== undefined) headers.Cookie = cookieHeader;

    const request = https.request(
      endpoint,
      {
        method: 'POST',
        headers,
        ...(agent === undefined ? {} : { agent }),
        ...(signal === undefined ? {} : { signal }),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('error', () => reject(fetchFailed()));
        response.on('end', () => {
          if (
            response.statusCode === undefined ||
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            reject(fetchFailed());
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
          } catch {
            reject(metadataInvalid());
          }
        });
      },
    );
    request.setTimeout(REQUEST_TIMEOUT_MILLISECONDS, () => {
      request.destroy();
      reject(fetchFailed());
    });
    request.on('error', () => reject(fetchFailed()));
    request.end(body);
  });
}

function objectField(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw metadataInvalid();
  }
  const fieldValue = (value as Record<string, unknown>)[field];
  if (
    typeof fieldValue !== 'object' ||
    fieldValue === null ||
    Array.isArray(fieldValue)
  ) {
    throw metadataInvalid();
  }
  return fieldValue as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw metadataInvalid();
  return value;
}

function playableCredentials(response: unknown): {
  readonly token: string;
  readonly eid: string;
} {
  const data = objectField(response, 'data');
  const playableUrl = nonEmptyString(data.playable_url);

  let parsed: URL;
  try {
    parsed = new URL(playableUrl);
  } catch {
    throw metadataInvalid();
  }
  const tokens = parsed.searchParams.getAll('token');
  const eids = parsed.searchParams.getAll('eid');
  if (
    tokens.length !== 1 ||
    tokens[0]?.trim() === '' ||
    eids.length !== 1 ||
    eids[0]?.trim() === ''
  ) {
    throw metadataInvalid();
  }
  return { token: tokens[0]!, eid: eids[0]! };
}

function videoAddress(feedInfo: Record<string, unknown>): string {
  const direct = feedInfo.videoUrl;
  let value: unknown;
  if (direct !== undefined && direct !== '') {
    value = direct;
  } else {
    const h264 = objectField(feedInfo, 'h264VideoInfo');
    value = h264.videoUrl;
  }

  const videoUrl = nonEmptyString(value);
  try {
    if (new URL(videoUrl).protocol !== 'https:') throw metadataInvalid();
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    throw metadataInvalid();
  }
  return videoUrl;
}

function resolvedMetadata(
  response: unknown,
  platformVideoId: string,
): ResolvedWeixinVideo {
  const data = objectField(response, 'data');
  const feedInfo = objectField(data, 'feedInfo');
  const authorInfo = objectField(data, 'authorInfo');
  return {
    platform: 'weixin',
    platformVideoId,
    title: nonEmptyString(feedInfo.description),
    authorNickname: nonEmptyString(authorInfo.nickname),
    videoUrl: videoAddress(feedInfo),
  };
}

export async function resolveWeixinVideo(
  options: ResolveWeixinVideoOptions,
): Promise<ResolvedWeixinVideo> {
  const platformVideoId = parseWeixinShareUrl(options.shareUrl);
  let cookieContents: string;
  try {
    cookieContents = await readFile(options.cookieFilePath, 'utf8');
  } catch {
    throw fetchFailed();
  }
  const cookieHeader = cookiesForEndpoint(cookieContents, YUANBAO_ENDPOINT);
  const proxyUrl = options.proxyUrl;
  const agent =
    proxyUrl === undefined
      ? undefined
      : new ProxyAgent({ getProxyForUrl: () => proxyUrl });

  try {
    const parseResponse = await postJson(
      YUANBAO_ENDPOINT,
      JSON.stringify({
        type: 'video_channel_url',
        url: options.shareUrl,
        scene: 1,
      }),
      cookieHeader,
      agent,
      options.signal,
    );
    const { token, eid } = playableCredentials(parseResponse);
    const feedResponse = await postJson(
      WEIXIN_FEED_ENDPOINT,
      JSON.stringify({ baseReq: { generalToken: token }, exportId: eid }),
      undefined,
      agent,
      options.signal,
    );
    return resolvedMetadata(feedResponse, platformVideoId);
  } finally {
    agent?.destroy();
  }
}
