import { BusinessError } from '../errors.js';
import {
  parseBilibiliFlatVideoUrl,
  parseBilibiliVideoMetadata,
  type BilibiliVideoMetadata,
} from '../bilibili.js';
import {
  parseYouTubeVideoUrl,
  isWithinUtcYearWindow,
  parseYouTubeVideoMetadata,
  type YouTubeVideoMetadata,
} from '../youtube.js';

const CHANNEL_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export type ChannelVideoMetadata = YouTubeVideoMetadata | BilibiliVideoMetadata;

export interface ChannelSource {
  readonly platform: 'youtube' | 'bilibili';
  readonly extractor: 'YoutubeTab' | 'BilibiliSpaceVideo';
  readonly platformChannelId: string | undefined;
  readonly fetchUrl: string;
  readonly flatPlaylist: boolean;
}

export interface PreparedEntry {
  readonly channelId: string;
  readonly video: ChannelVideoMetadata;
}

export function asChannelMetadataError(message: string): BusinessError {
  return new BusinessError('CHANNEL_METADATA_INVALID', message);
}

async function prepareYouTubeEntries(
  values: readonly unknown[],
  startedAt: Date,
  detailLoader: (url: string) => Promise<unknown>,
  expectedChannelId?: string,
  allowEmptyChannel = false,
  earliestPublishedDate?: string,
): Promise<readonly PreparedEntry[]> {
  const entries: PreparedEntry[] = [];
  const videoIds = new Set<string>();
  let channelId: string | undefined;

  for (const value of values) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw asChannelMetadataError('YouTube channel metadata must be an object');
    }
    const rawChannelId = (value as Record<string, unknown>).channel_id;
    if (
      typeof rawChannelId !== 'string' ||
      !CHANNEL_ID_PATTERN.test(rawChannelId)
    ) {
      throw asChannelMetadataError('YouTube metadata channel_id is invalid');
    }
    if (
      expectedChannelId !== undefined &&
      rawChannelId !== expectedChannelId
    ) {
      throw asChannelMetadataError(
        'YouTube metadata channel_id does not match the channel',
      );
    }
    if (channelId !== undefined && rawChannelId !== channelId) {
      throw asChannelMetadataError(
        'YouTube channel entries have inconsistent channel_id values',
      );
    }
    channelId = rawChannelId;

    const record = value as Record<string, unknown>;
    let metadataValue: unknown = value;
    if (record.upload_date === undefined) {
      if (typeof record.webpage_url !== 'string') {
        throw asChannelMetadataError('YouTube metadata webpage_url is required');
      }
      try {
        metadataValue = await detailLoader(
          parseYouTubeVideoUrl(record.webpage_url).url,
        );
      } catch (error) {
        if (error instanceof BusinessError) throw asChannelMetadataError(error.message);
        throw error;
      }
    }
    if (
      metadataValue !== value &&
      (typeof metadataValue !== 'object' ||
        metadataValue === null ||
        Array.isArray(metadataValue) ||
        (metadataValue as Record<string, unknown>).channel_id !== rawChannelId)
    ) {
      throw asChannelMetadataError(
        'YouTube metadata channel_id does not match the list entry',
      );
    }
    const video = parseYouTubeVideoMetadata(
      metadataValue,
      'CHANNEL_METADATA_INVALID',
    );
    if (videoIds.has(video.platformVideoId)) {
      throw asChannelMetadataError('YouTube channel contains duplicate video IDs');
    }
    videoIds.add(video.platformVideoId);
    if (
      earliestPublishedDate === undefined
        ? isWithinUtcYearWindow(video.publishedDate, startedAt)
        : video.publishedDate >= earliestPublishedDate &&
          video.publishedDate <= startedAt.toISOString().slice(0, 10)
    ) {
      entries.push({ channelId: rawChannelId, video });
    }
  }

  if (channelId === undefined) {
    if (allowEmptyChannel) return [];
    throw new BusinessError(
      'CHANNEL_FETCH_FAILED',
      'yt-dlp produced no channel entries',
    );
  }
  return entries;
}

async function prepareBilibiliEntries(
  values: readonly unknown[],
  source: ChannelSource,
  startedAt: Date,
  earliestPublishedDate: string,
  detailLoader: (url: string) => Promise<unknown>,
): Promise<readonly PreparedEntry[]> {
  const channelId = source.platformChannelId;
  if (channelId === undefined) {
    throw asChannelMetadataError('Bilibili space ID is missing');
  }
  const entries: PreparedEntry[] = [];
  const videoIds = new Set<string>();
  const latestPublishedDate = startedAt.toISOString().slice(0, 10);
  for (const value of values) {
    const videoUrl = parseBilibiliFlatVideoUrl(value);
    if (videoUrl === null) continue;
    const video = parseBilibiliVideoMetadata(
      await detailLoader(videoUrl),
      channelId,
      videoUrl,
    );
    if (videoIds.has(video.platformVideoId)) {
      throw asChannelMetadataError('Bilibili space contains duplicate video IDs');
    }
    videoIds.add(video.platformVideoId);
    if (video.publishedDate < earliestPublishedDate) break;
    if (video.publishedDate <= latestPublishedDate) {
      entries.push({ channelId, video });
    }
  }
  return entries;
}

export async function prepareChannelEntries(
  values: readonly unknown[],
  source: ChannelSource,
  startedAt: Date,
  earliestPublishedDate: string,
  detailLoader: (url: string) => Promise<unknown>,
  expectedChannelId?: string,
): Promise<readonly PreparedEntry[]> {
  if (source.platform === 'bilibili') {
    return prepareBilibiliEntries(
      values,
      source,
      startedAt,
      earliestPublishedDate,
      detailLoader,
    );
  }
  return prepareYouTubeEntries(
    values,
    startedAt,
    detailLoader,
    expectedChannelId,
    true,
    earliestPublishedDate,
  );
}
