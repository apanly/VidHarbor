import { BusinessError } from './errors.js';

const VIDEO_ID_PATTERN = '[A-Za-z0-9_-]{11}';
const CHANNEL_URL_PATTERN = new RegExp(
  '^https://www\\.youtube\\.com/(?:channel/[A-Za-z0-9_-]+|@[A-Za-z0-9._-]+)$',
);
const WATCH_URL_PATTERN = new RegExp(
  `^https://www\\.youtube\\.com/watch\\?v=(${VIDEO_ID_PATTERN})$`,
);
const SHORT_VIDEO_URL_PATTERN = new RegExp(
  `^https://youtu\\.be/(${VIDEO_ID_PATTERN})$`,
);
const YT_DLP_DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})$/;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export type YouTubeMetadataErrorCode =
  | 'CHANNEL_METADATA_INVALID'
  | 'VIDEO_METADATA_INVALID';

export interface YouTubeVideoUrl {
  readonly videoId: string;
  readonly url: string;
}

export interface YouTubeVideoMetadata {
  readonly platform: 'youtube';
  readonly platformVideoId: string;
  readonly title: string;
  readonly publishedDate: string;
  readonly url: string;
  readonly durationSeconds: number | null;
  readonly thumbnailUrl: string | null;
}

function canonicalWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function metadataError(
  code: YouTubeMetadataErrorCode,
  message: string,
): never {
  throw new BusinessError(code, message);
}

function formatUtcDate(date: Date): string {
  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function parseDateParts(
  value: string,
  pattern: RegExp,
): { readonly year: number; readonly month: number; readonly day: number } | null {
  const match = pattern.exec(value);
  if (match === null) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(year, month - 1, day);

  if (
    year < 1 ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

function parseUploadDate(
  value: unknown,
  code: YouTubeMetadataErrorCode,
): string {
  if (typeof value !== 'string') {
    return metadataError(code, 'YouTube metadata upload_date is required');
  }

  const parts = parseDateParts(value, YT_DLP_DATE_PATTERN);
  if (parts === null) {
    return metadataError(code, 'YouTube metadata upload_date is invalid');
  }

  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function normalizeYouTubeChannelUrl(url: string): string {
  if (!CHANNEL_URL_PATTERN.test(url)) {
    throw new BusinessError(
      'NOT_A_CHANNEL_URL',
      'URL must be a supported YouTube channel URL',
    );
  }

  return `${url}/videos`;
}

export function parseYouTubeVideoUrl(url: string): YouTubeVideoUrl {
  const match = WATCH_URL_PATTERN.exec(url) ?? SHORT_VIDEO_URL_PATTERN.exec(url);
  const videoId = match?.[1];
  if (videoId === undefined) {
    throw new BusinessError(
      'NOT_A_VIDEO_URL',
      'URL must be a supported YouTube video URL',
    );
  }

  return { videoId, url: canonicalWatchUrl(videoId) };
}

export function parseYouTubeVideoMetadata(
  value: unknown,
  errorCode: YouTubeMetadataErrorCode,
): YouTubeVideoMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return metadataError(errorCode, 'YouTube metadata must be an object');
  }

  const metadata = value as Record<string, unknown>;
  if (metadata.extractor_key !== 'Youtube') {
    return metadataError(errorCode, 'YouTube metadata extractor_key must be Youtube');
  }
  if (
    typeof metadata.id !== 'string' ||
    !new RegExp(`^${VIDEO_ID_PATTERN}$`).test(metadata.id)
  ) {
    return metadataError(errorCode, 'YouTube metadata id is invalid');
  }
  if (typeof metadata.title !== 'string' || metadata.title.trim() === '') {
    return metadataError(errorCode, 'YouTube metadata title is required');
  }

  const publishedDate = parseUploadDate(metadata.upload_date, errorCode);
  const url = canonicalWatchUrl(metadata.id);
  if (metadata.webpage_url !== url) {
    return metadataError(errorCode, 'YouTube metadata webpage_url is not canonical');
  }
  if (metadata.live_status !== 'not_live') {
    return metadataError(errorCode, 'YouTube metadata live_status must be not_live');
  }
  if (
    metadata.duration !== undefined &&
    (!Number.isSafeInteger(metadata.duration) || (metadata.duration as number) < 0)
  ) {
    return metadataError(errorCode, 'YouTube metadata duration is invalid');
  }
  if (
    metadata.thumbnail !== undefined &&
    (typeof metadata.thumbnail !== 'string' || metadata.thumbnail.trim() === '')
  ) {
    return metadataError(errorCode, 'YouTube metadata thumbnail is invalid');
  }

  return {
    platform: 'youtube',
    platformVideoId: metadata.id,
    title: metadata.title,
    publishedDate,
    url,
    durationSeconds:
      metadata.duration === undefined ? null : metadata.duration as number,
    thumbnailUrl:
      metadata.thumbnail === undefined ? null : metadata.thumbnail,
  };
}

export function getUtcOneYearBoundary(startedAt: Date): string {
  if (!Number.isFinite(startedAt.getTime())) {
    throw new BusinessError('VALIDATION_ERROR', 'check start time is invalid');
  }

  const targetYear = startedAt.getUTCFullYear() - 1;
  const month = startedAt.getUTCMonth();
  const lastDayOfTargetMonth = new Date(0);
  lastDayOfTargetMonth.setUTCHours(0, 0, 0, 0);
  lastDayOfTargetMonth.setUTCFullYear(targetYear, month + 1, 0);

  const boundary = new Date(0);
  boundary.setUTCHours(0, 0, 0, 0);
  boundary.setUTCFullYear(
    targetYear,
    month,
    Math.min(startedAt.getUTCDate(), lastDayOfTargetMonth.getUTCDate()),
  );
  return formatUtcDate(boundary);
}

export function isWithinUtcYearWindow(
  publishedDate: string,
  startedAt: Date,
): boolean {
  if (parseDateParts(publishedDate, ISO_DATE_PATTERN) === null) {
    throw new BusinessError('VALIDATION_ERROR', 'published date is invalid');
  }
  if (!Number.isFinite(startedAt.getTime())) {
    throw new BusinessError('VALIDATION_ERROR', 'check start time is invalid');
  }

  const upperBoundary = formatUtcDate(startedAt);
  return (
    publishedDate >= getUtcOneYearBoundary(startedAt) &&
    publishedDate <= upperBoundary
  );
}
