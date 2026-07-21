import type { DatabaseConnection } from '../db/client.js';
import { BusinessError } from '../errors.js';
import {
  PAGE_SIZE,
  pageOffset,
  pagination,
  type Paginated,
} from '../http/pagination.js';
import { validateChannelName } from '../filesystem.js';
import { formatFailureReason } from '../redaction.js';
import {
  parseBilibiliChannelUrl,
  parseBilibiliFlatVideoUrl,
  parseBilibiliVideoMetadata,
  type BilibiliVideoMetadata,
} from '../bilibili.js';
import {
  parseYouTubeVideoUrl,
  isWithinUtcYearWindow,
  normalizeYouTubeChannelUrl,
  parseYouTubeVideoMetadata,
  type YouTubeVideoMetadata,
} from '../youtube.js';
import type {
  YtDlpOperations,
  YtDlpTaskManager,
} from '../yt-dlp-task-manager.js';
import { isYtDlpTaskCancellationError } from '../yt-dlp-task-cancellation.js';
import type { CookieAuthorizationService } from './cookie-authorization.js';

export interface Channel {
  readonly id: number;
  readonly platform: ChannelPlatform;
  readonly extractor: ChannelExtractor;
  readonly url: string;
  readonly customName: string;
  readonly proxyId: number | null;
  readonly authorizationPlatform: ChannelPlatform | null;
  readonly checkIntervalMinutes: number | null;
  readonly effectiveCheckIntervalMinutes: number;
  readonly pausedAt: string | null;
  readonly initialSync: {
    readonly status: 'pending' | 'syncing' | 'succeeded' | 'failed';
    readonly error: string | null;
  };
  readonly unreadNotificationCount: number;
  readonly lastCheck: {
    readonly startedAt: string | null;
    readonly nextAt: string | null;
    readonly result: 'success' | 'no_updates' | 'failed' | null;
    readonly error: string | null;
  };
}

export interface ChannelVideo {
  readonly id: number;
  readonly title: string;
  readonly publishedDate: string;
  readonly url: string;
  readonly durationSeconds: number | null;
  readonly thumbnailUrl: string | null;
  readonly downloadId: number | null;
  readonly downloadStatus:
    | 'pending'
    | 'downloading'
    | 'running'
    | 'completed'
    | 'failed'
    | 'canceled'
    | 'interrupted'
    | null;
  readonly downloadFinishedAt: string | null;
  readonly downloadOutputSizeBytes: number | null;
  readonly downloadFailureReason: string | null;
}

export interface ChannelCheck {
  readonly id: number;
  readonly kind: 'initial' | 'scheduled';
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly result: 'success' | 'no_updates' | 'failed' | null;
  readonly newVideoCount: number;
  readonly failureReason: string | null;
}

interface CreateChannelResult {
  readonly channel: Channel;
  readonly historicalVideoCount: number;
}

interface AcceptedChannelCreation {
  readonly accepted: true;
}

export interface InitialSyncTaskQueue {
  trackInitialSync(task: Promise<unknown>): void;
}

export interface CheckChannelResult {
  readonly newVideoCount: number;
}

interface ChannelInput {
  readonly url: string;
  readonly customName: string;
  readonly proxyId: number | null;
  readonly authorizationPlatform: ChannelPlatform | null;
  readonly checkIntervalMinutes: number | null;
}

interface UpdateChannelInput {
  readonly customName: string;
  readonly proxyId: number | null;
  readonly authorizationPlatform: ChannelPlatform | null;
  readonly checkIntervalMinutes: number | null;
}

interface ChannelRow {
  readonly id: number;
  readonly platform: ChannelPlatform;
  readonly extractor: ChannelExtractor;
  readonly source_url: string;
  readonly custom_name: string;
  readonly proxy_id: number | null;
  readonly authorization_platform: ChannelPlatform | null;
  readonly check_interval_minutes: number | null;
  readonly effective_check_interval_minutes: number | null;
  readonly paused_at: string | null;
  readonly initial_sync_status: 'pending' | 'syncing' | 'succeeded' | 'failed';
  readonly initial_sync_error: string | null;
  readonly last_check_started_at: string | null;
  readonly next_check_at: string | null;
  readonly last_check_result: 'success' | 'no_updates' | 'failed' | null;
  readonly last_check_error: string | null;
  readonly unread_notification_count: number;
}

interface ChannelVideoRow {
  readonly id: number;
  readonly title: string;
  readonly published_date: string;
  readonly source_url: string;
  readonly duration_seconds: number | null;
  readonly thumbnail_url: string | null;
  readonly download_id: number | null;
  readonly download_status:
    | 'pending'
    | 'downloading'
    | 'running'
    | 'completed'
    | 'failed'
    | 'canceled'
    | 'interrupted'
    | null;
  readonly download_finished_at: string | null;
  readonly download_output_size_bytes: number | null;
  readonly download_failure_reason: string | null;
}

interface ChannelCheckRow {
  readonly id: number;
  readonly kind: 'initial' | 'scheduled';
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly result: 'success' | 'no_updates' | 'failed' | null;
  readonly new_video_count: number;
  readonly failure_reason: string | null;
}

interface PreparedEntry {
  readonly channelId: string;
  readonly video: ChannelVideoMetadata;
}

interface InitialConfiguration {
  readonly globalCheckIntervalMinutes: number;
  readonly proxyUrl: string | undefined;
}

interface PreparedInitialSync {
  readonly channelId: number;
  readonly startedAt: Date;
  readonly historyMonths: number;
  readonly row: {
    readonly source_url: string;
    readonly custom_name: string;
    readonly proxy_id: number | null;
    readonly authorization_platform: ChannelPlatform | null;
    readonly check_interval_minutes: number | null;
  };
  readonly configuration: InitialConfiguration;
  readonly checkId: number;
}

interface ScheduledChannel {
  readonly id: number;
  readonly platform: ChannelPlatform;
  readonly platformChannelId: string | undefined;
  readonly url: string;
  readonly proxyUrl: string | undefined;
  readonly authorizationPlatform: ChannelPlatform | null;
}

interface ScheduledChannelRow {
  readonly id: number;
  readonly platform: ChannelPlatform;
  readonly platform_channel_id: string | null;
  readonly source_url: string;
  readonly proxy_id: number | null;
  readonly proxy_url: string | null;
  readonly authorization_platform: ChannelPlatform | null;
  readonly initial_sync_status: 'pending' | 'syncing' | 'succeeded' | 'failed';
}

const CHANNEL_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MINUTE_MILLISECONDS = 60_000;
const SCHEDULED_DISCOVERY_MONTHS = 1;

type ChannelPlatform = 'youtube' | 'bilibili';
type ChannelExtractor = 'YoutubeTab' | 'BilibiliSpaceVideo';
type ChannelVideoMetadata = YouTubeVideoMetadata | BilibiliVideoMetadata;

interface ChannelSource {
  readonly platform: ChannelPlatform;
  readonly extractor: ChannelExtractor;
  readonly platformChannelId: string | undefined;
  readonly fetchUrl: string;
  readonly flatPlaylist: boolean;
}

function parseChannelSource(url: string): ChannelSource {
  if (url.startsWith('https://www.youtube.com/')) {
    return {
      platform: 'youtube',
      extractor: 'YoutubeTab',
      platformChannelId: undefined,
      fetchUrl: normalizeYouTubeChannelUrl(url),
      flatPlaylist: false,
    };
  }
  if (url.startsWith('https://space.bilibili.com/')) {
    const source = parseBilibiliChannelUrl(url);
    return { ...source, flatPlaylist: true };
  }
  throw new BusinessError(
    'NOT_A_CHANNEL_URL',
    'URL must be a supported YouTube or Bilibili channel URL',
  );
}

function persistenceError(): BusinessError {
  return new BusinessError('PERSISTENCE_ERROR', 'channel persistence failed');
}

function parseInput(input: unknown): ChannelInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid channel input');
  }

  const keys = Object.keys(input);
  if (
    (keys.length !== 4 && keys.length !== 5) ||
    !keys.includes('url') ||
    !keys.includes('customName') ||
    !keys.includes('proxyId') ||
    !keys.includes('checkIntervalMinutes') ||
    (keys.length === 5 && !keys.includes('authorizationPlatform'))
  ) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid channel input');
  }

  const value = input as Record<string, unknown>;
  if (
    typeof value.url !== 'string' ||
    typeof value.customName !== 'string' ||
    (value.proxyId !== null &&
      (!Number.isSafeInteger(value.proxyId) || (value.proxyId as number) < 1)) ||
    (value.checkIntervalMinutes !== null &&
      (!Number.isSafeInteger(value.checkIntervalMinutes) ||
        (value.checkIntervalMinutes as number) < 1)) ||
    (value.authorizationPlatform !== undefined &&
      value.authorizationPlatform !== null &&
      value.authorizationPlatform !== 'youtube' &&
      value.authorizationPlatform !== 'bilibili')
  ) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid channel input');
  }

  validateChannelName(value.customName);
  const source = parseChannelSource(value.url);
  const authorizationPlatform = value.authorizationPlatform ?? null;
  if (authorizationPlatform !== null && authorizationPlatform !== source.platform) {
    throw new BusinessError('VALIDATION_ERROR', 'channel authorization platform mismatch');
  }
  return {
    url: value.url,
    customName: value.customName,
    proxyId: value.proxyId as number | null,
    authorizationPlatform,
    checkIntervalMinutes: value.checkIntervalMinutes as number | null,
  };
}

function parseUpdateInput(input: unknown): UpdateChannelInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid channel input');
  }

  const keys = Object.keys(input);
  if (
    (keys.length !== 3 && keys.length !== 4) ||
    !keys.includes('customName') ||
    !keys.includes('proxyId') ||
    !keys.includes('checkIntervalMinutes') ||
    (keys.length === 4 && !keys.includes('authorizationPlatform'))
  ) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid channel input');
  }

  const value = input as Record<string, unknown>;
  if (
    typeof value.customName !== 'string' ||
    (value.proxyId !== null &&
      (!Number.isSafeInteger(value.proxyId) || (value.proxyId as number) < 1)) ||
    (value.checkIntervalMinutes !== null &&
      (!Number.isSafeInteger(value.checkIntervalMinutes) ||
        (value.checkIntervalMinutes as number) < 1)) ||
    (value.authorizationPlatform !== undefined &&
      value.authorizationPlatform !== null &&
      value.authorizationPlatform !== 'youtube' &&
      value.authorizationPlatform !== 'bilibili')
  ) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid channel input');
  }

  validateChannelName(value.customName);
  return {
    customName: value.customName,
    proxyId: value.proxyId as number | null,
    authorizationPlatform: (value.authorizationPlatform ?? null) as ChannelPlatform | null,
    checkIntervalMinutes: value.checkIntervalMinutes as number | null,
  };
}

function toChannel(row: ChannelRow): Channel {
  const effectiveCheckIntervalMinutes =
    row.effective_check_interval_minutes;
  if (
    typeof effectiveCheckIntervalMinutes !== 'number' ||
    !Number.isSafeInteger(effectiveCheckIntervalMinutes)
  ) {
    throw persistenceError();
  }

  return {
    id: row.id,
    platform: row.platform,
    extractor: row.extractor,
    url: row.source_url,
    customName: row.custom_name,
    proxyId: row.proxy_id,
    authorizationPlatform: row.authorization_platform,
    checkIntervalMinutes: row.check_interval_minutes,
    effectiveCheckIntervalMinutes,
    pausedAt: row.paused_at,
    initialSync: {
      status: row.initial_sync_status,
      error: row.initial_sync_error === null
        ? null
        : formatFailureReason(row.initial_sync_error, []),
    },
    unreadNotificationCount: row.unread_notification_count,
    lastCheck: {
      startedAt: row.last_check_started_at,
      nextAt: row.next_check_at,
      result: row.last_check_result,
      error: row.last_check_error === null
        ? null
        : formatFailureReason(row.last_check_error, []),
    },
  };
}

const CHANNEL_SELECT = `
  SELECT c.id, c.platform, c.extractor, c.source_url, c.custom_name,
         c.proxy_id, c.authorization_platform, c.check_interval_minutes, c.paused_at,
         c.initial_sync_status, c.initial_sync_error,
         COALESCE(c.check_interval_minutes, s.global_check_interval_minutes)
           AS effective_check_interval_minutes,
         c.last_check_started_at, c.next_check_at, c.last_check_result,
         c.last_check_error,
         (
           SELECT COUNT(*)
           FROM notifications n
           JOIN videos v ON v.id = n.video_id
           WHERE v.channel_id = c.id AND n.read_at IS NULL
         ) AS unread_notification_count
  FROM channels c
  CROSS JOIN settings s ON s.id = 1`;

function loadInitialConfiguration(
  database: DatabaseConnection,
  proxyId: number | null,
): InitialConfiguration {
  try {
    const globalCheckIntervalMinutes = database
      .prepare(
        'SELECT global_check_interval_minutes FROM settings WHERE id = 1',
      )
      .pluck()
      .get() as number | null | undefined;
    if (globalCheckIntervalMinutes === null) {
      throw new BusinessError(
        'GLOBAL_INTERVAL_NOT_CONFIGURED',
        'global check interval is not configured',
      );
    }
    if (globalCheckIntervalMinutes === undefined) {
      throw new Error('settings row is missing');
    }

    if (proxyId === null) {
      return { globalCheckIntervalMinutes, proxyUrl: undefined };
    }

    const proxyUrl = database
      .prepare('SELECT proxy_url FROM proxies WHERE id = ?')
      .pluck()
      .get(proxyId) as string | undefined;
    if (proxyUrl === undefined) {
      throw new BusinessError('PROXY_NOT_FOUND', 'proxy not found');
    }
    return { globalCheckIntervalMinutes, proxyUrl };
  } catch (error) {
    if (error instanceof BusinessError) {
      throw error;
    }
    throw persistenceError();
  }
}

function failureReason(error: Error, proxyUrl: string | undefined): string {
  return formatFailureReason(
    error.message,
    proxyUrl === undefined ? [] : [proxyUrl],
  );
}

function recordFailedCheck(
  database: DatabaseConnection,
  checkId: number,
  error: BusinessError,
  proxyUrl: string | undefined,
): void {
  try {
    const result = database
      .prepare(
        `UPDATE channel_checks
         SET finished_at = ?, result = 'failed', failure_reason = ?
         WHERE id = ?`,
      )
      .run(new Date().toISOString(), failureReason(error, proxyUrl), checkId);
    if (result.changes !== 1) {
      throw new Error('channel check is missing');
    }
  } catch {
    throw persistenceError();
  }
}

function asChannelMetadataError(message: string): BusinessError {
  return new BusinessError('CHANNEL_METADATA_INVALID', message);
}

function nextCheckAt(startedAt: string, intervalMinutes: number): string {
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) {
    throw new BusinessError('VALIDATION_ERROR', 'check start time is invalid');
  }
  return new Date(started + intervalMinutes * MINUTE_MILLISECONDS).toISOString();
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

async function prepareChannelEntries(
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

function validateChannelId(channelId: number): void {
  if (!Number.isSafeInteger(channelId) || channelId < 1) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid channel ID');
  }
}

function loadScheduledChannel(
  database: DatabaseConnection,
  channelId: number,
): ScheduledChannel {
  try {
    const row = database
      .prepare(
        `SELECT c.id, c.platform, c.platform_channel_id, c.source_url, c.proxy_id,
                c.authorization_platform, p.proxy_url, c.initial_sync_status
         FROM channels c
         LEFT JOIN proxies p ON p.id = c.proxy_id
         WHERE c.id = ?`,
      )
      .get(channelId) as ScheduledChannelRow | undefined;
    if (row === undefined) {
      throw new BusinessError('CHANNEL_NOT_FOUND', 'channel not found');
    }
    if (row.initial_sync_status !== 'succeeded') {
      throw new BusinessError('CHANNEL_IN_USE', 'channel initial sync is required');
    }
    if (row.proxy_id !== null && row.proxy_url === null) {
      throw new Error('channel proxy is missing');
    }
    return {
      id: row.id,
      platform: row.platform,
      platformChannelId: row.platform_channel_id ?? undefined,
      url: row.source_url,
      proxyUrl: row.proxy_url ?? undefined,
      authorizationPlatform: row.authorization_platform,
    };
  } catch (error) {
    if (error instanceof BusinessError) {
      throw error;
    }
    throw persistenceError();
  }
}

function beginScheduledCheck(
  database: DatabaseConnection,
  channel: ScheduledChannel,
  startedAt: string,
): number {
  try {
    database.exec('BEGIN IMMEDIATE');
    const result = database
      .prepare(
        `INSERT INTO channel_checks (
          kind, channel_id, requested_url, started_at
        ) VALUES ('scheduled', ?, ?, ?)`,
      )
      .run(channel.id, channel.url, startedAt);
    const updated = database
      .prepare(
        `UPDATE channels
         SET last_check_started_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(startedAt, startedAt, channel.id);
    if (updated.changes !== 1) {
      throw new Error('channel is missing');
    }
    database.exec('COMMIT');
    return Number(result.lastInsertRowid);
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // The transaction may not have started.
    }
    if (error instanceof BusinessError) throw error;
    throw persistenceError();
  }
}

function recordScheduledFailure(
  database: DatabaseConnection,
  channel: ScheduledChannel,
  checkId: number,
  error: BusinessError,
): void {
  const finishedAt = new Date().toISOString();
  const reason = failureReason(error, channel.proxyUrl);
  try {
    database.exec('BEGIN IMMEDIATE');
    const updatedCheck = database
      .prepare(
        `UPDATE channel_checks
         SET finished_at = ?, result = 'failed', new_video_count = 0,
             failure_reason = ?
         WHERE id = ?`,
      )
      .run(finishedAt, reason, checkId);
    const updatedChannel = database
      .prepare(
        `UPDATE channels
         SET last_check_result = 'failed', last_check_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(reason, finishedAt, channel.id);
    if (updatedCheck.changes !== 1 || updatedChannel.changes !== 1) {
      throw new Error('scheduled check state is missing');
    }
    database.exec('COMMIT');
  } catch {
    try {
      database.exec('ROLLBACK');
    } catch {
      // The transaction may not have started.
    }
    throw persistenceError();
  }
}

function completeScheduledCheck(
  database: DatabaseConnection,
  channel: ScheduledChannel,
  checkId: number,
  entries: readonly PreparedEntry[],
): CheckChannelResult {
  const completedAt = new Date().toISOString();
  try {
    database.exec('BEGIN IMMEDIATE');
    const discoveredChannelId = entries[0]?.channelId;
    if (channel.platformChannelId === undefined && discoveredChannelId !== undefined) {
      const duplicate = database
        .prepare(
          `SELECT 1 FROM channels
           WHERE platform = ? AND platform_channel_id = ? AND id <> ?`,
        )
        .pluck()
        .get(channel.platform, discoveredChannelId, channel.id);
      if (duplicate !== undefined) {
        throw new BusinessError('CHANNEL_ALREADY_EXISTS', 'channel already exists');
      }
      database
        .prepare('UPDATE channels SET platform_channel_id = ? WHERE id = ?')
        .run(discoveredChannelId, channel.id);
    }
    const findVideo = database
      .prepare(
        `SELECT id FROM videos
         WHERE platform = ? AND platform_video_id = ?`,
      )
      .pluck();
    const insertVideo = database.prepare(
      `INSERT INTO videos (
        channel_id, platform, platform_video_id, title, published_date,
        source_url, duration_seconds, thumbnail_url, discovery_kind,
        discovered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`,
    );
    const insertNotification = database.prepare(
      `INSERT INTO notifications (video_id, created_at) VALUES (?, ?)`,
    );

    let newVideoCount = 0;
    for (const entry of entries) {
      if (findVideo.get(channel.platform, entry.video.platformVideoId) !== undefined) {
        continue;
      }
      const insertedVideo = insertVideo.run(
        channel.id,
        channel.platform,
        entry.video.platformVideoId,
        entry.video.title,
        entry.video.publishedDate,
        entry.video.url,
        entry.video.durationSeconds,
        entry.video.thumbnailUrl,
        completedAt,
      );
      insertNotification.run(Number(insertedVideo.lastInsertRowid), completedAt);
      newVideoCount += 1;
    }

    const result = newVideoCount === 0 ? 'no_updates' : 'success';
    const intervalMinutes = database
      .prepare(
        `SELECT COALESCE(c.check_interval_minutes, s.global_check_interval_minutes)
         FROM channels c CROSS JOIN settings s
         WHERE c.id = ? AND s.id = 1`,
      )
      .pluck()
      .get(channel.id) as number | null | undefined;
    if (typeof intervalMinutes !== 'number') {
      throw new Error('channel interval is missing');
    }
    const updatedCheck = database
      .prepare(
        `UPDATE channel_checks
         SET finished_at = ?, result = ?, new_video_count = ?,
             failure_reason = NULL
         WHERE id = ?`,
      )
      .run(completedAt, result, newVideoCount, checkId);
    const updatedChannel = database
      .prepare(
        `UPDATE channels
         SET last_check_result = ?, last_check_error = NULL,
             next_check_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(result, nextCheckAt(completedAt, intervalMinutes), completedAt, channel.id);
    if (updatedCheck.changes !== 1 || updatedChannel.changes !== 1) {
      throw new Error('scheduled check state is missing');
    }

    database.exec('COMMIT');
    return { newVideoCount };
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // The transaction may not have started.
    }
    if (error instanceof BusinessError) throw error;
    throw persistenceError();
  }
}

function assertNameAvailable(
  database: DatabaseConnection,
  customNameKey: string,
): void {
  const existingId = database
    .prepare('SELECT id FROM channels WHERE custom_name_key = ?')
    .pluck()
    .get(customNameKey);
  if (existingId !== undefined) {
    throw new BusinessError('CHANNEL_NAME_EXISTS', 'channel name already exists');
  }
}

function insertSynchronizedChannel(
  database: DatabaseConnection,
  input: ChannelInput,
  entries: readonly PreparedEntry[],
  checkId: number,
  globalCheckIntervalMinutes: number,
  channelId: number,
  source: ChannelSource,
): CreateChannelResult {
  const platformChannelId = entries[0]?.channelId ?? source.platformChannelId;
  database.exec('BEGIN IMMEDIATE');
  try {
    const duplicateChannelId = platformChannelId === undefined ? undefined : database
      .prepare(
        `SELECT id FROM channels
         WHERE platform = ? AND platform_channel_id = ?`,
      )
      .pluck()
      .get(source.platform, platformChannelId);
    if (duplicateChannelId !== undefined && duplicateChannelId !== channelId) {
      throw new BusinessError(
        'CHANNEL_ALREADY_EXISTS',
        'channel already exists',
      );
    }

    const completedAt = new Date().toISOString();
    const effectiveIntervalMinutes =
      input.checkIntervalMinutes ?? globalCheckIntervalMinutes;
    const updated = database
      .prepare(
        `UPDATE channels
         SET platform_channel_id = ?, initial_sync_status = 'succeeded',
             initial_sync_error = NULL, initial_synced_at = ?,
             next_check_at = ?, updated_at = ?
         WHERE id = ? AND initial_sync_status = 'syncing'`,
      )
      .run(
        platformChannelId ?? null,
        completedAt,
        nextCheckAt(completedAt, effectiveIntervalMinutes),
        completedAt,
        channelId,
      );
    if (updated.changes !== 1) throw new Error('channel sync state changed');

    const insertVideo = database.prepare(
      `INSERT INTO videos (
        channel_id, platform, platform_video_id, title, published_date,
        source_url, duration_seconds, thumbnail_url, discovery_kind,
        discovered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'historical', ?)`,
    );
    for (const entry of entries) {
      insertVideo.run(
        channelId,
        source.platform,
        entry.video.platformVideoId,
        entry.video.title,
        entry.video.publishedDate,
        entry.video.url,
        entry.video.durationSeconds,
        entry.video.thumbnailUrl,
        completedAt,
      );
    }

    const updatedCheck = database
      .prepare(
        `UPDATE channel_checks
         SET channel_id = ?, finished_at = ?, result = 'success',
             new_video_count = 0, failure_reason = NULL
         WHERE id = ?`,
      )
      .run(channelId, completedAt, checkId);
    if (updatedCheck.changes !== 1) {
      throw new Error('channel check is missing');
    }

    database.exec('COMMIT');
    return {
      channel: {
        id: channelId,
        platform: source.platform,
        extractor: source.extractor,
        url: input.url,
        customName: input.customName,
        proxyId: input.proxyId,
        authorizationPlatform: input.authorizationPlatform,
        checkIntervalMinutes: input.checkIntervalMinutes,
        effectiveCheckIntervalMinutes: effectiveIntervalMinutes,
        pausedAt: null,
        initialSync: { status: 'succeeded', error: null },
        unreadNotificationCount: 0,
        lastCheck: {
          startedAt: null,
          nextAt: nextCheckAt(completedAt, effectiveIntervalMinutes),
          result: null,
          error: null,
        },
      },
      historicalVideoCount: entries.length,
    };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

async function completeChannelCreation(
  database: DatabaseConnection,
  operations: YtDlpOperations,
  channelInput: ChannelInput,
  source: ChannelSource,
  configuration: InitialConfiguration,
  checkId: number,
  startedAt: Date,
  channelId: number,
  dateAfter: string,
  earliestPublishedDate: string,
  cookieAuthorizationService?: CookieAuthorizationService,
): Promise<CreateChannelResult> {
  let values: readonly unknown[];
  let cookieFilePath: string | undefined;
  try {
    cookieFilePath = channelInput.authorizationPlatform === null
      ? undefined
      : await cookieAuthorizationService?.getConfiguredFilePath(
          channelInput.authorizationPlatform,
        );
    if (
      channelInput.authorizationPlatform !== null &&
      cookieFilePath === undefined
    ) {
      throw new Error('channel authorization service is unavailable');
    }
    values = await operations.fetchChannelEntries({
      url: source.fetchUrl,
      ...(cookieFilePath === undefined ? {} : { cookieFilePath }),
      ...(configuration.proxyUrl === undefined
        ? {}
        : { proxyUrl: configuration.proxyUrl }),
      ...(source.flatPlaylist ? { flatPlaylist: true } : { dateAfter }),
      allowEmpty: true,
    });
  } catch (error) {
    const businessError = new BusinessError(
      'CHANNEL_FETCH_FAILED',
      error instanceof Error ? error.message : 'channel fetch failed',
    );
    recordFailedCheck(
      database,
      checkId,
      businessError,
      configuration.proxyUrl,
    );
    if (isYtDlpTaskCancellationError(error)) throw error;
    throw businessError;
  }

  let entries: readonly PreparedEntry[];
  try {
    entries = await prepareChannelEntries(
      values,
      source,
      startedAt,
      earliestPublishedDate,
      (url) =>
        operations.fetchVideoMetadata({
          url,
          ...(cookieFilePath === undefined ? {} : { cookieFilePath }),
          ...(configuration.proxyUrl === undefined
            ? {}
            : { proxyUrl: configuration.proxyUrl }),
        }),
    );
  } catch (error) {
    const businessError =
      error instanceof BusinessError
        ? error
        : asChannelMetadataError('channel metadata is invalid');
    recordFailedCheck(
      database,
      checkId,
      businessError,
      configuration.proxyUrl,
    );
    if (isYtDlpTaskCancellationError(error)) throw error;
    throw businessError;
  }

  try {
    return insertSynchronizedChannel(
      database,
      channelInput,
      entries,
      checkId,
      configuration.globalCheckIntervalMinutes,
      channelId,
      source,
    );
  } catch (error) {
    const businessError =
      error instanceof BusinessError ? error : persistenceError();
    recordFailedCheck(
      database,
      checkId,
      businessError,
      configuration.proxyUrl,
    );
    throw businessError;
  }
}

const INITIAL_HISTORY_MONTHS = new Set([1, 3, 6, 12]);

function parseInitialSyncInput(input: unknown): number {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).length !== 1 ||
    !Object.hasOwn(input, 'historyMonths')
  ) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid initial sync input');
  }
  const historyMonths = (input as Record<string, unknown>).historyMonths;
  if (typeof historyMonths !== 'number' || !INITIAL_HISTORY_MONTHS.has(historyMonths)) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid initial sync input');
  }
  return historyMonths;
}

function historyStartDate(startedAt: Date, historyMonths: number): string {
  const year = startedAt.getUTCFullYear();
  const monthIndex = startedAt.getUTCMonth() - historyMonths;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(startedAt.getUTCDate(), lastDay);
  return new Date(Date.UTC(targetYear, targetMonth, day)).toISOString().slice(0, 10);
}

export function saveChannel(
  database: DatabaseConnection,
  input: unknown,
  now = new Date(),
): Channel {
  const channelInput = parseInput(input);
  if (!Number.isFinite(now.getTime())) {
    throw new BusinessError('VALIDATION_ERROR', 'channel creation time is invalid');
  }
  const source = parseChannelSource(channelInput.url);
  loadInitialConfiguration(database, channelInput.proxyId);
  const createdAt = now.toISOString();

  try {
    database.exec('BEGIN IMMEDIATE');
    assertNameAvailable(database, channelInput.customName.toLowerCase());
    const sameUrl = database
      .prepare('SELECT 1 FROM channels WHERE source_url = ?')
      .pluck()
      .get(channelInput.url);
    if (sameUrl !== undefined) {
      throw new BusinessError('CHANNEL_ALREADY_EXISTS', 'channel already exists');
    }
    const result = database
      .prepare(
        `INSERT INTO channels (
          platform, extractor, platform_channel_id, source_url, custom_name,
          custom_name_key, proxy_id, authorization_platform,
          check_interval_minutes, paused_at,
          initial_sync_status, initial_sync_error, initial_synced_at,
          created_at, updated_at
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL,
                  'pending', NULL, NULL, ?, ?)`,
      )
      .run(
        source.platform,
        source.extractor,
        channelInput.url,
        channelInput.customName,
        channelInput.customName.toLowerCase(),
        channelInput.proxyId,
        channelInput.authorizationPlatform,
        channelInput.checkIntervalMinutes,
        createdAt,
        createdAt,
      );
    const row = database
      .prepare(`${CHANNEL_SELECT} WHERE c.id = ?`)
      .get(Number(result.lastInsertRowid)) as ChannelRow;
    const channel = toChannel(row);
    database.exec('COMMIT');
    return channel;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* The transaction may not have started. */ }
    if (error instanceof BusinessError) throw error;
    throw persistenceError();
  }
}

function prepareInitialSync(
  database: DatabaseConnection,
  channelId: number,
  input: unknown,
  startedAt = new Date(),
): PreparedInitialSync {
  validateChannelId(channelId);
  const historyMonths = parseInitialSyncInput(input);
  if (!Number.isFinite(startedAt.getTime())) {
    throw new BusinessError('VALIDATION_ERROR', 'check start time is invalid');
  }

  const row = database
    .prepare(
      `SELECT source_url, custom_name, proxy_id, authorization_platform,
              check_interval_minutes,
              initial_sync_status
       FROM channels WHERE id = ?`,
    )
    .get(channelId) as {
      source_url: string;
      custom_name: string;
      proxy_id: number | null;
      authorization_platform: ChannelPlatform | null;
      check_interval_minutes: number | null;
      initial_sync_status: 'pending' | 'syncing' | 'succeeded' | 'failed';
    } | undefined;
  if (row === undefined) throw new BusinessError('CHANNEL_NOT_FOUND', 'channel not found');
  if (row.initial_sync_status === 'syncing') {
    throw new BusinessError('CHANNEL_IN_USE', 'channel initial sync is running');
  }
  if (row.initial_sync_status === 'succeeded') {
    throw new BusinessError('CHANNEL_IN_USE', 'channel initial sync already succeeded');
  }
  const configuration = loadInitialConfiguration(database, row.proxy_id);
  const checkId = (() => {
    database.exec('BEGIN IMMEDIATE');
    try {
      const updated = database
        .prepare(
          `UPDATE channels SET initial_sync_status = 'syncing',
             initial_sync_error = NULL, updated_at = ?
           WHERE id = ? AND initial_sync_status IN ('pending','failed')`,
        )
        .run(startedAt.toISOString(), channelId);
      if (updated.changes !== 1) throw new BusinessError('CHANNEL_IN_USE', 'channel sync state changed');
      const result = database
        .prepare(
          `INSERT INTO channel_checks (kind, channel_id, requested_url, started_at)
           VALUES ('initial', ?, ?, ?)`,
        )
        .run(channelId, row.source_url, startedAt.toISOString());
      database.exec('COMMIT');
      return Number(result.lastInsertRowid);
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  })();

  return {
    channelId,
    startedAt,
    historyMonths,
    row,
    configuration,
    checkId,
  };
}

async function completeInitialSync(
  database: DatabaseConnection,
  prepared: PreparedInitialSync,
  operations: YtDlpOperations,
  cookieAuthorizationService?: CookieAuthorizationService,
): Promise<CreateChannelResult> {
  const {
    channelId,
    startedAt,
    historyMonths,
    row,
    configuration,
    checkId,
  } = prepared;

  const earliestPublishedDate = historyStartDate(startedAt, historyMonths);
  const source = parseChannelSource(row.source_url);
  try {
    return await completeChannelCreation(
      database,
      operations,
      {
        url: row.source_url,
        customName: row.custom_name,
        proxyId: row.proxy_id,
        authorizationPlatform: row.authorization_platform,
        checkIntervalMinutes: row.check_interval_minutes,
      },
      source,
      configuration,
      checkId,
      startedAt,
      channelId,
      earliestPublishedDate.replaceAll('-', ''),
      earliestPublishedDate,
      cookieAuthorizationService,
    );
  } catch (error) {
    const failure =
      error instanceof BusinessError || isYtDlpTaskCancellationError(error)
        ? error
        : persistenceError();
    const reason = failureReason(failure, configuration.proxyUrl);
    try {
      database
        .prepare(
          `UPDATE channels SET initial_sync_status = 'failed',
             initial_sync_error = ?, updated_at = ?
           WHERE id = ? AND initial_sync_status = 'syncing'`,
        )
        .run(reason, new Date().toISOString(), channelId);
    } catch {
      throw persistenceError();
    }
    throw failure;
  }
}

export function acceptInitialChannelSync(
  database: DatabaseConnection,
  taskManager: YtDlpTaskManager,
  taskQueue: InitialSyncTaskQueue,
  channelId: number,
  input: unknown,
  startedAt = new Date(),
  cookieAuthorizationService?: CookieAuthorizationService,
): AcceptedChannelCreation {
  const prepared = prepareInitialSync(
    database,
    channelId,
    input,
    startedAt,
  );
  const task = taskManager.submit({
    type: 'channel_initial_sync',
    execute: (operations) => completeInitialSync(
      database,
      prepared,
      operations,
      cookieAuthorizationService,
    ),
  });
  taskQueue.trackInitialSync(task.result);
  return { accepted: true };
}

export function initialSyncChannel(
  database: DatabaseConnection,
  taskManager: YtDlpTaskManager,
  channelId: number,
  input: unknown,
  startedAt = new Date(),
  cookieAuthorizationService?: CookieAuthorizationService,
): Promise<CreateChannelResult> {
  const prepared = prepareInitialSync(database, channelId, input, startedAt);
  return taskManager.submit({
    type: 'channel_initial_sync',
    execute: (operations) => completeInitialSync(
      database,
      prepared,
      operations,
      cookieAuthorizationService,
    ),
  }).result;
}

async function executeChannelCheck(
  database: DatabaseConnection,
  operations: YtDlpOperations,
  channelId: number,
  startedAt = new Date(),
  cookieAuthorizationService?: CookieAuthorizationService,
): Promise<CheckChannelResult> {
  validateChannelId(channelId);
  if (!Number.isFinite(startedAt.getTime())) {
    throw new BusinessError('VALIDATION_ERROR', 'check start time is invalid');
  }

  const channel = loadScheduledChannel(database, channelId);
  const source = parseChannelSource(channel.url);
  if (
    source.platform !== channel.platform ||
    (source.platformChannelId !== undefined &&
      source.platformChannelId !== channel.platformChannelId)
  ) {
    throw persistenceError();
  }
  const earliestPublishedDate = historyStartDate(
    startedAt,
    SCHEDULED_DISCOVERY_MONTHS,
  );
  const checkId = beginScheduledCheck(
    database,
    channel,
    startedAt.toISOString(),
  );

  let values: readonly unknown[];
  let cookieFilePath: string | undefined;
  try {
    cookieFilePath = channel.authorizationPlatform === null
      ? undefined
      : await cookieAuthorizationService?.getConfiguredFilePath(
          channel.authorizationPlatform,
        );
    if (
      channel.authorizationPlatform !== null &&
      cookieFilePath === undefined
    ) {
      throw new Error('channel authorization service is unavailable');
    }
    values = await operations.fetchChannelEntries({
      url: source.fetchUrl,
      ...(cookieFilePath === undefined ? {} : { cookieFilePath }),
      ...(channel.proxyUrl === undefined
        ? {}
        : { proxyUrl: channel.proxyUrl }),
      ...(source.flatPlaylist
        ? { flatPlaylist: true }
        : { dateAfter: earliestPublishedDate.replaceAll('-', '') }),
      allowEmpty: true,
    });
  } catch (error) {
    const businessError = new BusinessError(
      'CHANNEL_FETCH_FAILED',
      error instanceof Error ? error.message : 'channel fetch failed',
    );
    recordScheduledFailure(database, channel, checkId, businessError);
    if (isYtDlpTaskCancellationError(error)) throw error;
    throw businessError;
  }

  let entries: readonly PreparedEntry[];
  try {
    entries = await prepareChannelEntries(
      values,
      source,
      startedAt,
      earliestPublishedDate,
      (url) =>
        operations.fetchVideoMetadata({
          url,
          ...(cookieFilePath === undefined ? {} : { cookieFilePath }),
          ...(channel.proxyUrl === undefined
            ? {}
            : { proxyUrl: channel.proxyUrl }),
      }),
      channel.platformChannelId,
    );
  } catch (error) {
    const businessError =
      error instanceof BusinessError
        ? error
        : asChannelMetadataError('channel metadata is invalid');
    recordScheduledFailure(database, channel, checkId, businessError);
    if (isYtDlpTaskCancellationError(error)) throw error;
    throw businessError;
  }

  try {
    return completeScheduledCheck(database, channel, checkId, entries);
  } catch (error) {
    const businessError =
      error instanceof BusinessError ? error : persistenceError();
    recordScheduledFailure(database, channel, checkId, businessError);
    throw businessError;
  }
}

export function checkChannel(
  database: DatabaseConnection,
  taskManager: YtDlpTaskManager,
  channelId: number,
  startedAt = new Date(),
  cookieAuthorizationService?: CookieAuthorizationService,
): Promise<CheckChannelResult> {
  return taskManager.submit({
    type: 'channel_manual_check',
    execute: (operations) =>
      executeChannelCheck(
        database,
        operations,
        channelId,
        startedAt,
        cookieAuthorizationService,
      ),
  }).result;
}

export function checkScheduledChannel(
  database: DatabaseConnection,
  taskManager: YtDlpTaskManager,
  channelId: number,
  startedAt = new Date(),
  cookieAuthorizationService?: CookieAuthorizationService,
): Promise<CheckChannelResult> {
  return taskManager.submit({
    type: 'channel_scheduled_check',
    execute: (operations) =>
      executeChannelCheck(
        database,
        operations,
        channelId,
        startedAt,
        cookieAuthorizationService,
      ),
  }).result;
}

export function listChannels(database: DatabaseConnection): Channel[] {
  try {
    const rows = database
      .prepare(`${CHANNEL_SELECT} ORDER BY c.id DESC`)
      .all() as ChannelRow[];
    return rows.map(toChannel);
  } catch (error) {
    if (error instanceof BusinessError) {
      throw error;
    }
    throw persistenceError();
  }
}

export function listChannelsPage(
  database: DatabaseConnection,
  page: number,
): Paginated<Channel> {
  try {
    const totalItems = database.prepare('SELECT COUNT(*) FROM channels').pluck().get() as number;
    const rows = database
      .prepare(`${CHANNEL_SELECT} ORDER BY c.id DESC LIMIT ? OFFSET ?`)
      .all(PAGE_SIZE, pageOffset(page)) as ChannelRow[];
    return { items: rows.map(toChannel), pagination: pagination(page, totalItems) };
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    throw persistenceError();
  }
}

export function listUpdatedChannels(
  database: DatabaseConnection,
): readonly Channel[] {
  try {
    const rows = database
      .prepare(
        `${CHANNEL_SELECT}
         WHERE c.last_check_result = 'success'
         ORDER BY c.last_check_started_at DESC, c.id DESC`,
      )
      .all() as ChannelRow[];
    return rows.map(toChannel);
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    throw persistenceError();
  }
}

export function getChannel(database: DatabaseConnection, channelId: number): Channel {
  validateChannelId(channelId);
  try {
    const row = database
      .prepare(`${CHANNEL_SELECT} WHERE c.id = ?`)
      .get(channelId) as ChannelRow | undefined;
    if (row === undefined) throw new BusinessError('CHANNEL_NOT_FOUND', 'channel not found');
    return toChannel(row);
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    throw persistenceError();
  }
}

export function updateChannel(
  database: DatabaseConnection,
  channelId: number,
  input: unknown,
): Channel {
  validateChannelId(channelId);
  const channelInput = parseUpdateInput(input);
  const customNameKey = channelInput.customName.toLowerCase();

  try {
    database.exec('BEGIN IMMEDIATE');
    const existingChannel = database
      .prepare('SELECT id, platform FROM channels WHERE id = ?')
      .get(channelId) as { id: number; platform: ChannelPlatform } | undefined;
    if (existingChannel === undefined) {
      throw new BusinessError('CHANNEL_NOT_FOUND', 'channel not found');
    }
    if (
      channelInput.authorizationPlatform !== null &&
      channelInput.authorizationPlatform !== existingChannel.platform
    ) {
      throw new BusinessError(
        'VALIDATION_ERROR',
        'channel authorization platform mismatch',
      );
    }

    if (channelInput.proxyId !== null) {
      const proxyId = database
        .prepare('SELECT id FROM proxies WHERE id = ?')
        .pluck()
        .get(channelInput.proxyId);
      if (proxyId === undefined) {
        throw new BusinessError('PROXY_NOT_FOUND', 'proxy not found');
      }
    }

    const conflictingChannelId = database
      .prepare(
        `SELECT id FROM channels
         WHERE custom_name_key = ? AND id <> ?`,
      )
      .pluck()
      .get(customNameKey, channelId);
    if (conflictingChannelId !== undefined) {
      throw new BusinessError(
        'CHANNEL_NAME_EXISTS',
        'channel name already exists',
      );
    }

    const updatedAt = new Date().toISOString();
    const updated = database
      .prepare(
        `UPDATE channels
         SET custom_name = ?, custom_name_key = ?, proxy_id = ?,
             authorization_platform = ?, check_interval_minutes = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        channelInput.customName,
        customNameKey,
        channelInput.proxyId,
        channelInput.authorizationPlatform,
        channelInput.checkIntervalMinutes,
        updatedAt,
        channelId,
      );
    if (updated.changes !== 1) {
      throw new Error('channel is missing');
    }

    const row = database
      .prepare(`${CHANNEL_SELECT} WHERE c.id = ?`)
      .get(channelId) as ChannelRow | undefined;
    if (row === undefined) {
      throw new Error('channel is missing');
    }
    const channel = toChannel(row);
    database.exec('COMMIT');
    return channel;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // The transaction may not have started.
    }
    if (error instanceof BusinessError) {
      throw error;
    }
    throw persistenceError();
  }
}

export function deleteChannel(
  database: DatabaseConnection,
  channelId: number,
): void {
  validateChannelId(channelId);

  try {
    database.exec('BEGIN IMMEDIATE');
    const channelExists = database
      .prepare('SELECT 1 FROM channels WHERE id = ?')
      .pluck()
      .get(channelId);
    if (channelExists === undefined) {
      throw new BusinessError('CHANNEL_NOT_FOUND', 'channel not found');
    }

    const downloadExists = database
      .prepare('SELECT 1 FROM downloads WHERE channel_id = ? LIMIT 1')
      .pluck()
      .get(channelId);
    if (downloadExists !== undefined) {
      throw new BusinessError(
        'CHANNEL_IN_USE',
        'channel has download records',
      );
    }

    const runningCheckExists = database
      .prepare(
        `SELECT 1 FROM channel_checks
         WHERE channel_id = ? AND finished_at IS NULL
         LIMIT 1`,
      )
      .pluck()
      .get(channelId);
    if (runningCheckExists !== undefined) {
      throw new BusinessError('CHANNEL_IN_USE', 'channel check is running');
    }

    database
      .prepare(
        `DELETE FROM notifications
         WHERE video_id IN (SELECT id FROM videos WHERE channel_id = ?)`,
      )
      .run(channelId);
    database.prepare('DELETE FROM channel_checks WHERE channel_id = ?').run(channelId);
    database.prepare('DELETE FROM videos WHERE channel_id = ?').run(channelId);
    const deleted = database.prepare('DELETE FROM channels WHERE id = ?').run(channelId);
    if (deleted.changes !== 1) {
      throw new Error('channel is missing');
    }
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // The transaction may not have started.
    }
    if (error instanceof BusinessError) {
      throw error;
    }
    throw persistenceError();
  }
}

function assertChannelExists(
  database: DatabaseConnection,
  channelId: number,
): void {
  const id = database
    .prepare('SELECT id FROM channels WHERE id = ?')
    .pluck()
    .get(channelId);
  if (id === undefined) {
    throw new BusinessError('CHANNEL_NOT_FOUND', 'channel not found');
  }
}

export function listChannelVideos(
  database: DatabaseConnection,
  channelId: number,
): ChannelVideo[] {
  validateChannelId(channelId);
  try {
    assertChannelExists(database, channelId);
    const rows = database
      .prepare(
        `SELECT v.id, v.title, v.published_date, v.source_url,
                v.duration_seconds, v.thumbnail_url,
                d.id AS download_id, d.status AS download_status,
                d.finished_at AS download_finished_at,
                d.output_size_bytes AS download_output_size_bytes,
                d.failure_reason AS download_failure_reason
         FROM videos v
         LEFT JOIN downloads d ON d.id = (
           SELECT latest.id
           FROM downloads latest
           WHERE latest.video_id = v.id
           ORDER BY latest.created_at DESC, latest.id DESC
           LIMIT 1
         )
         WHERE v.channel_id = ?
         ORDER BY v.published_date DESC, v.id DESC`,
      )
      .all(channelId) as ChannelVideoRow[];
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      publishedDate: row.published_date,
      url: row.source_url,
      durationSeconds: row.duration_seconds,
      thumbnailUrl: row.thumbnail_url,
      downloadId: row.download_id,
      downloadStatus: row.download_status,
      downloadFinishedAt: row.download_finished_at,
      downloadOutputSizeBytes: row.download_output_size_bytes,
      downloadFailureReason: row.download_failure_reason,
    }));
  } catch (error) {
    if (error instanceof BusinessError) {
      throw error;
    }
    throw persistenceError();
  }
}

export function listChannelVideosPage(
  database: DatabaseConnection,
  channelId: number,
  page: number,
  query: string,
): Paginated<ChannelVideo> {
  validateChannelId(channelId);
  try {
    assertChannelExists(database, channelId);
    const titleFilter = query === '' ? '' : ' AND instr(lower(v.title), lower(?)) > 0';
    const parameters = query === '' ? [channelId] : [channelId, query];
    const totalItems = database
      .prepare(`SELECT COUNT(*) FROM videos v WHERE v.channel_id = ?${titleFilter}`)
      .pluck()
      .get(...parameters) as number;
    const rows = database
      .prepare(
        `SELECT v.id, v.title, v.published_date, v.source_url,
                v.duration_seconds, v.thumbnail_url,
                d.id AS download_id, d.status AS download_status,
                d.finished_at AS download_finished_at,
                d.output_size_bytes AS download_output_size_bytes,
                d.failure_reason AS download_failure_reason
         FROM videos v
         LEFT JOIN downloads d ON d.id = (
           SELECT latest.id
           FROM downloads latest
           WHERE latest.video_id = v.id
           ORDER BY latest.created_at DESC, latest.id DESC
           LIMIT 1
         )
         WHERE v.channel_id = ?${titleFilter}
         ORDER BY v.published_date DESC, v.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...parameters, PAGE_SIZE, pageOffset(page)) as ChannelVideoRow[];
    return {
      items: rows.map((row) => ({
        id: row.id,
        title: row.title,
        publishedDate: row.published_date,
        url: row.source_url,
        durationSeconds: row.duration_seconds,
        thumbnailUrl: row.thumbnail_url,
        downloadId: row.download_id,
        downloadStatus: row.download_status,
        downloadFinishedAt: row.download_finished_at,
        downloadOutputSizeBytes: row.download_output_size_bytes,
        downloadFailureReason: row.download_failure_reason,
      })),
      pagination: pagination(page, totalItems),
    };
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    throw persistenceError();
  }
}

export function pauseChannel(
  database: DatabaseConnection,
  channelId: number,
  now = new Date(),
): Channel {
  validateChannelId(channelId);
  if (!Number.isFinite(now.getTime())) {
    throw new BusinessError('VALIDATION_ERROR', 'pause time is invalid');
  }
  const pausedAt = now.toISOString();
  try {
    const result = database
      .prepare(
        `UPDATE channels
         SET paused_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(pausedAt, pausedAt, channelId);
    if (result.changes !== 1) {
      throw new BusinessError('CHANNEL_NOT_FOUND', 'channel not found');
    }
    const row = database
      .prepare(`${CHANNEL_SELECT} WHERE c.id = ?`)
      .get(channelId) as ChannelRow | undefined;
    if (row === undefined) throw new Error('channel is missing');
    return toChannel(row);
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    throw persistenceError();
  }
}

export function resumeChannel(
  database: DatabaseConnection,
  channelId: number,
  now = new Date(),
): Channel {
  validateChannelId(channelId);
  if (!Number.isFinite(now.getTime())) {
    throw new BusinessError('VALIDATION_ERROR', 'resume time is invalid');
  }
  const resumedAt = now.toISOString();
  try {
    const intervalMinutes = database
      .prepare(
        `SELECT COALESCE(c.check_interval_minutes, s.global_check_interval_minutes)
         FROM channels c CROSS JOIN settings s
         WHERE c.id = ? AND s.id = 1`,
      )
      .pluck()
      .get(channelId) as number | null | undefined;
    if (intervalMinutes === undefined) {
      throw new BusinessError('CHANNEL_NOT_FOUND', 'channel not found');
    }
    if (typeof intervalMinutes !== 'number') {
      throw new BusinessError(
        'GLOBAL_INTERVAL_NOT_CONFIGURED',
        'global check interval is not configured',
      );
    }
    const result = database
      .prepare(
        `UPDATE channels
         SET paused_at = NULL, next_check_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(nextCheckAt(resumedAt, intervalMinutes), resumedAt, channelId);
    if (result.changes !== 1) {
      throw new BusinessError('CHANNEL_NOT_FOUND', 'channel not found');
    }
    const row = database
      .prepare(`${CHANNEL_SELECT} WHERE c.id = ?`)
      .get(channelId) as ChannelRow | undefined;
    if (row === undefined) throw new Error('channel is missing');
    return toChannel(row);
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    throw persistenceError();
  }
}

export function listChannelChecks(
  database: DatabaseConnection,
  channelId: number,
): ChannelCheck[] {
  validateChannelId(channelId);
  try {
    assertChannelExists(database, channelId);
    const rows = database
      .prepare(
        `SELECT id, kind, started_at, finished_at, result,
                new_video_count, failure_reason
         FROM channel_checks
         WHERE channel_id = ?
         ORDER BY started_at DESC, id DESC`,
      )
      .all(channelId) as ChannelCheckRow[];
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      result: row.result,
      newVideoCount: row.new_video_count,
      failureReason: row.failure_reason === null
        ? null
        : formatFailureReason(row.failure_reason, []),
    }));
  } catch (error) {
    if (error instanceof BusinessError) {
      throw error;
    }
    throw persistenceError();
  }
}

export function listChannelChecksPage(
  database: DatabaseConnection,
  channelId: number,
  page: number,
): Paginated<ChannelCheck> {
  validateChannelId(channelId);
  try {
    assertChannelExists(database, channelId);
    const totalItems = database
      .prepare('SELECT COUNT(*) FROM channel_checks WHERE channel_id = ?')
      .pluck()
      .get(channelId) as number;
    const rows = database
      .prepare(
        `SELECT id, kind, started_at, finished_at, result,
                new_video_count, failure_reason
         FROM channel_checks
         WHERE channel_id = ?
         ORDER BY started_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(channelId, PAGE_SIZE, pageOffset(page)) as ChannelCheckRow[];
    return {
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        result: row.result,
        newVideoCount: row.new_video_count,
        failureReason: row.failure_reason === null
          ? null
          : formatFailureReason(row.failure_reason, []),
      })),
      pagination: pagination(page, totalItems),
    };
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    throw persistenceError();
  }
}

export function recoverInterruptedChannelSyncs(
  database: DatabaseConnection,
  finishedAt = new Date().toISOString(),
): void {
  const initialReason = 'initial synchronization interrupted by restart';
  const scheduledReason = 'scheduled check interrupted by restart';
  database.exec('BEGIN IMMEDIATE');
  try {
    database
      .prepare(
        `UPDATE channels
         SET last_check_result = 'failed', last_check_error = ?, updated_at = ?
         WHERE id IN (
           SELECT channel_id FROM channel_checks
           WHERE kind = 'scheduled' AND finished_at IS NULL
         )`,
      )
      .run(scheduledReason, finishedAt);
    database
      .prepare(
        `UPDATE channel_checks
         SET finished_at = ?, result = 'failed', failure_reason = ?
         WHERE kind = 'scheduled' AND finished_at IS NULL`,
      )
      .run(finishedAt, scheduledReason);
    database
      .prepare(
        `UPDATE channel_checks
         SET finished_at = ?, result = 'failed', failure_reason = ?
         WHERE kind = 'initial' AND finished_at IS NULL`,
      )
      .run(finishedAt, initialReason);
    database
      .prepare(
        `UPDATE channels
         SET initial_sync_status = 'failed', initial_sync_error = ?, updated_at = ?
         WHERE initial_sync_status = 'syncing'`,
      )
      .run(initialReason, finishedAt);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
