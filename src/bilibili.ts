import { BusinessError } from './errors.js';

const SPACE_URL_PATTERN = /^https:\/\/space\.bilibili\.com\/([1-9]\d*)$/;
const VIDEO_ID_PATTERN = /^BV[A-Za-z0-9]{10}$/;
const VIDEO_URL_PATTERN = /^https:\/\/www\.bilibili\.com\/video\/(BV[A-Za-z0-9]{10})$/;
const YT_DLP_DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})$/;

export interface BilibiliChannelSource {
  readonly platform: 'bilibili';
  readonly extractor: 'BilibiliSpaceVideo';
  readonly platformChannelId: string;
  readonly fetchUrl: string;
}

export interface BilibiliVideoMetadata {
  readonly platform: 'bilibili';
  readonly platformVideoId: string;
  readonly title: string;
  readonly publishedDate: string;
  readonly url: string;
  readonly durationSeconds: number | null;
  readonly thumbnailUrl: string | null;
}

function metadataError(message: string): never {
  throw new BusinessError('CHANNEL_METADATA_INVALID', message);
}

function parseUploadDate(value: unknown): string {
  if (typeof value !== 'string') {
    return metadataError('Bilibili metadata upload_date is required');
  }
  const match = YT_DLP_DATE_PATTERN.exec(value);
  if (match === null) {
    return metadataError('Bilibili metadata upload_date is invalid');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1 ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return metadataError('Bilibili metadata upload_date is invalid');
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseBilibiliChannelUrl(url: string): BilibiliChannelSource {
  const channelId = SPACE_URL_PATTERN.exec(url)?.[1];
  if (channelId === undefined) {
    throw new BusinessError(
      'NOT_A_CHANNEL_URL',
      'URL must be a supported Bilibili space URL',
    );
  }
  return {
    platform: 'bilibili',
    extractor: 'BilibiliSpaceVideo',
    platformChannelId: channelId,
    fetchUrl: `${url}/video`,
  };
}

export function parseBilibiliFlatVideoUrl(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return metadataError('Bilibili space entry must be an object');
  }
  const entry = value as Record<string, unknown>;
  if (entry.ie_key === 'BilibiliCollectionList') return null;
  if (entry.ie_key !== 'BiliBili' || typeof entry.url !== 'string') {
    return metadataError('Bilibili space entry is not an ordinary video');
  }
  const videoId = VIDEO_URL_PATTERN.exec(entry.url)?.[1];
  if (videoId === undefined || entry.id !== videoId) {
    return metadataError('Bilibili space video URL is invalid');
  }
  return entry.url;
}

export function parseBilibiliVideoMetadata(
  value: unknown,
  expectedChannelId: string,
  expectedVideoUrl: string,
): BilibiliVideoMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return metadataError('Bilibili metadata must be an object');
  }
  const metadata = value as Record<string, unknown>;
  const videoId = VIDEO_URL_PATTERN.exec(expectedVideoUrl)?.[1];
  if (videoId === undefined) {
    return metadataError('Bilibili expected video URL is invalid');
  }
  if (metadata.extractor_key !== 'BiliBili') {
    return metadataError('Bilibili metadata extractor_key must be BiliBili');
  }
  if (metadata.id !== videoId && metadata.id !== `${videoId}_p1`) {
    return metadataError('Bilibili metadata id does not match the space entry');
  }
  if (!VIDEO_ID_PATTERN.test(videoId)) {
    return metadataError('Bilibili metadata id is invalid');
  }
  if (metadata.uploader_id !== expectedChannelId) {
    return metadataError('Bilibili metadata uploader_id does not match the space');
  }
  if (metadata.webpage_url !== expectedVideoUrl) {
    return metadataError('Bilibili metadata webpage_url is not canonical');
  }
  if (typeof metadata.title !== 'string' || metadata.title.trim() === '') {
    return metadataError('Bilibili metadata title is required');
  }
  if (
    metadata.duration !== undefined &&
    (typeof metadata.duration !== 'number' ||
      !Number.isFinite(metadata.duration) ||
      metadata.duration < 0 ||
      !Number.isSafeInteger(Math.ceil(metadata.duration)))
  ) {
    return metadataError('Bilibili metadata duration is invalid');
  }
  if (
    metadata.thumbnail !== undefined &&
    (typeof metadata.thumbnail !== 'string' || metadata.thumbnail.trim() === '')
  ) {
    return metadataError('Bilibili metadata thumbnail is invalid');
  }
  return {
    platform: 'bilibili',
    platformVideoId: videoId,
    title: metadata.title,
    publishedDate: parseUploadDate(metadata.upload_date),
    url: expectedVideoUrl,
    durationSeconds:
      metadata.duration === undefined ? null : Math.ceil(metadata.duration),
    thumbnailUrl:
      metadata.thumbnail === undefined ? null : metadata.thumbnail,
  };
}
