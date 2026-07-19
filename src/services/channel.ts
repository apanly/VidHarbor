import type { DatabaseConnection } from '../db/client.js';
import { BusinessError } from '../errors.js';
import { validateChannelName } from '../filesystem.js';
import { redactStderr } from '../redaction.js';
import {
  parseYouTubeVideoUrl,
  isWithinUtcYearWindow,
  normalizeYouTubeChannelUrl,
  parseYouTubeVideoMetadata,
  type YouTubeVideoMetadata,
} from '../youtube.js';
import { fetchChannelEntries, fetchVideoMetadata } from '../yt-dlp.js';

export interface Channel {
  readonly id: number;
  readonly platform: 'youtube';
  readonly extractor: 'YoutubeTab';
  readonly url: string;
  readonly customName: string;
  readonly proxyId: number | null;
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
  readonly downloadStatus:
    | 'pending'
    | 'downloading'
    | 'completed'
    | 'failed'
    | null;
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
  readonly checkIntervalMinutes: number | null;
}

interface UpdateChannelInput {
  readonly customName: string;
  readonly proxyId: number | null;
  readonly checkIntervalMinutes: number | null;
}

interface ChannelRow {
  readonly id: number;
  readonly platform: 'youtube';
  readonly extractor: 'YoutubeTab';
  readonly source_url: string;
  readonly custom_name: string;
  readonly proxy_id: number | null;
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
  readonly download_status:
    | 'pending'
    | 'downloading'
    | 'completed'
    | 'failed'
    | null;
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
  readonly video: YouTubeVideoMetadata;
}

interface InitialConfiguration {
  readonly globalCheckIntervalMinutes: number;
  readonly proxyUrl: string | undefined;
}

interface PreparedInitialSync {
  readonly channelId: number;
  readonly ytDlpExecutablePath: string;
  readonly startedAt: Date;
  readonly historyMonths: number;
  readonly row: {
    readonly source_url: string;
    readonly custom_name: string;
    readonly proxy_id: number | null;
    readonly check_interval_minutes: number | null;
  };
  readonly configuration: InitialConfiguration;
  readonly checkId: number;
}

interface ScheduledChannel {
  readonly id: number;
  readonly platformChannelId: string | undefined;
  readonly url: string;
  readonly proxyUrl: string | undefined;
}

interface ScheduledChannelRow {
  readonly id: number;
  readonly platform_channel_id: string | null;
  readonly source_url: string;
  readonly proxy_id: number | null;
  readonly proxy_url: string | null;
  readonly initial_sync_status: 'pending' | 'syncing' | 'succeeded' | 'failed';
}

const CHANNEL_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MINUTE_MILLISECONDS = 60_000;

function persistenceError(): BusinessError {
  return new BusinessError('PERSISTENCE_ERROR', 'channel persistence failed');
}

function parseInput(input: unknown): ChannelInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid channel input');
  }

  const keys = Object.keys(input);
  if (
    keys.length !== 4 ||
    !keys.includes('url') ||
    !keys.includes('customName') ||
    !keys.includes('proxyId') ||
    !keys.includes('checkIntervalMinutes')
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
        (value.checkIntervalMinutes as number) < 1))
  ) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid channel input');
  }

  validateChannelName(value.customName);
  normalizeYouTubeChannelUrl(value.url);
  return {
    url: value.url,
    customName: value.customName,
    proxyId: value.proxyId as number | null,
    checkIntervalMinutes: value.checkIntervalMinutes as number | null,
  };
}

function parseUpdateInput(input: unknown): UpdateChannelInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid channel input');
  }

  const keys = Object.keys(input);
  if (
    keys.length !== 3 ||
    !keys.includes('customName') ||
    !keys.includes('proxyId') ||
    !keys.includes('checkIntervalMinutes')
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
        (value.checkIntervalMinutes as number) < 1))
  ) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid channel input');
  }

  validateChannelName(value.customName);
  return {
    customName: value.customName,
    proxyId: value.proxyId as number | null,
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
    checkIntervalMinutes: row.check_interval_minutes,
    effectiveCheckIntervalMinutes,
    pausedAt: row.paused_at,
    initialSync: {
      status: row.initial_sync_status,
      error: row.initial_sync_error,
    },
    unreadNotificationCount: row.unread_notification_count,
    lastCheck: {
      startedAt: row.last_check_started_at,
      nextAt: row.next_check_at,
      result: row.last_check_result,
      error: row.last_check_error,
    },
  };
}

const CHANNEL_SELECT = `
  SELECT c.id, c.platform, c.extractor, c.source_url, c.custom_name,
         c.proxy_id, c.check_interval_minutes, c.paused_at,
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

function failureReason(error: BusinessError, proxyUrl: string | undefined): string {
  return redactStderr(
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

async function prepareEntries(
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
        `SELECT c.id, c.platform_channel_id, c.source_url, c.proxy_id,
                p.proxy_url, c.initial_sync_status
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
      platformChannelId: row.platform_channel_id ?? undefined,
      url: row.source_url,
      proxyUrl: row.proxy_url ?? undefined,
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
           WHERE platform = 'youtube' AND platform_channel_id = ? AND id <> ?`,
        )
        .pluck()
        .get(discoveredChannelId, channel.id);
      if (duplicate !== undefined) {
        throw new BusinessError('CHANNEL_ALREADY_EXISTS', 'YouTube channel already exists');
      }
      database
        .prepare('UPDATE channels SET platform_channel_id = ? WHERE id = ?')
        .run(discoveredChannelId, channel.id);
    }
    const findVideo = database
      .prepare(
        `SELECT id FROM videos
         WHERE platform = 'youtube' AND platform_video_id = ?`,
      )
      .pluck();
    const insertVideo = database.prepare(
      `INSERT INTO videos (
        channel_id, platform, platform_video_id, title, published_date,
        source_url, duration_seconds, thumbnail_url, discovery_kind,
        discovered_at
      ) VALUES (?, 'youtube', ?, ?, ?, ?, ?, ?, 'new', ?)`,
    );
    const insertNotification = database.prepare(
      `INSERT INTO notifications (video_id, created_at) VALUES (?, ?)`,
    );

    let newVideoCount = 0;
    for (const entry of entries) {
      if (findVideo.get(entry.video.platformVideoId) !== undefined) {
        continue;
      }
      const insertedVideo = insertVideo.run(
        channel.id,
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
): CreateChannelResult {
  const firstEntry = entries[0];
  database.exec('BEGIN IMMEDIATE');
  try {
    const duplicateChannelId = firstEntry === undefined ? undefined : database
      .prepare(
        `SELECT id FROM channels
         WHERE platform = 'youtube' AND platform_channel_id = ?`,
      )
      .pluck()
      .get(firstEntry.channelId);
    if (duplicateChannelId !== undefined && duplicateChannelId !== channelId) {
      throw new BusinessError(
        'CHANNEL_ALREADY_EXISTS',
        'YouTube channel already exists',
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
        firstEntry?.channelId ?? null,
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
      ) VALUES (?, 'youtube', ?, ?, ?, ?, ?, ?, 'historical', ?)`,
    );
    for (const entry of entries) {
      insertVideo.run(
        channelId,
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
        platform: 'youtube',
        extractor: 'YoutubeTab',
        url: input.url,
        customName: input.customName,
        proxyId: input.proxyId,
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
  ytDlpExecutablePath: string,
  channelInput: ChannelInput,
  normalizedUrl: string,
  configuration: InitialConfiguration,
  checkId: number,
  startedAt: Date,
  channelId: number,
  dateAfter: string,
  earliestPublishedDate: string,
): Promise<CreateChannelResult> {
  let values: readonly unknown[];
  try {
    values = await fetchChannelEntries({
      executablePath: ytDlpExecutablePath,
      url: normalizedUrl,
      ...(configuration.proxyUrl === undefined
        ? {}
        : { proxyUrl: configuration.proxyUrl }),
      dateAfter,
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
    throw businessError;
  }

  let entries: readonly PreparedEntry[];
  try {
    entries = await prepareEntries(
      values,
      startedAt,
      (url) =>
        fetchVideoMetadata({
          executablePath: ytDlpExecutablePath,
          url,
          ...(configuration.proxyUrl === undefined
            ? {}
            : { proxyUrl: configuration.proxyUrl }),
        }),
      undefined,
      true,
      earliestPublishedDate,
    );
  } catch (error) {
    const businessError =
      error instanceof BusinessError
        ? error
        : asChannelMetadataError('YouTube channel metadata is invalid');
    recordFailedCheck(
      database,
      checkId,
      businessError,
      configuration.proxyUrl,
    );
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
  normalizeYouTubeChannelUrl(channelInput.url);
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
      throw new BusinessError('CHANNEL_ALREADY_EXISTS', 'YouTube channel already exists');
    }
    const result = database
      .prepare(
        `INSERT INTO channels (
          platform, extractor, platform_channel_id, source_url, custom_name,
          custom_name_key, proxy_id, check_interval_minutes, paused_at,
          initial_sync_status, initial_sync_error, initial_synced_at,
          created_at, updated_at
        ) VALUES ('youtube', 'YoutubeTab', NULL, ?, ?, ?, ?, ?, NULL,
                  'pending', NULL, NULL, ?, ?)`,
      )
      .run(
        channelInput.url,
        channelInput.customName,
        channelInput.customName.toLowerCase(),
        channelInput.proxyId,
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
  ytDlpExecutablePath: string,
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
      `SELECT source_url, custom_name, proxy_id, check_interval_minutes,
              initial_sync_status
       FROM channels WHERE id = ?`,
    )
    .get(channelId) as {
      source_url: string;
      custom_name: string;
      proxy_id: number | null;
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
    ytDlpExecutablePath,
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
): Promise<CreateChannelResult> {
  const {
    channelId,
    ytDlpExecutablePath,
    startedAt,
    historyMonths,
    row,
    configuration,
    checkId,
  } = prepared;

  const earliestPublishedDate = historyStartDate(startedAt, historyMonths);
  try {
    return await completeChannelCreation(
      database,
      ytDlpExecutablePath,
      {
        url: row.source_url,
        customName: row.custom_name,
        proxyId: row.proxy_id,
        checkIntervalMinutes: row.check_interval_minutes,
      },
      normalizeYouTubeChannelUrl(row.source_url),
      configuration,
      checkId,
      startedAt,
      channelId,
      earliestPublishedDate.replaceAll('-', ''),
      earliestPublishedDate,
    );
  } catch (error) {
    const businessError = error instanceof BusinessError ? error : persistenceError();
    const reason = failureReason(businessError, configuration.proxyUrl);
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
    throw businessError;
  }
}

export function acceptInitialChannelSync(
  database: DatabaseConnection,
  ytDlpExecutablePath: string,
  taskQueue: InitialSyncTaskQueue,
  channelId: number,
  input: unknown,
  startedAt = new Date(),
): AcceptedChannelCreation {
  const prepared = prepareInitialSync(
    database,
    ytDlpExecutablePath,
    channelId,
    input,
    startedAt,
  );
  taskQueue.trackInitialSync(completeInitialSync(database, prepared));
  return { accepted: true };
}

export function initialSyncChannel(
  database: DatabaseConnection,
  ytDlpExecutablePath: string,
  channelId: number,
  input: unknown,
  startedAt = new Date(),
): Promise<CreateChannelResult> {
  return completeInitialSync(
    database,
    prepareInitialSync(
      database,
      ytDlpExecutablePath,
      channelId,
      input,
      startedAt,
    ),
  );
}

export async function checkChannel(
  database: DatabaseConnection,
  ytDlpExecutablePath: string,
  channelId: number,
  startedAt = new Date(),
): Promise<CheckChannelResult> {
  validateChannelId(channelId);
  if (!Number.isFinite(startedAt.getTime())) {
    throw new BusinessError('VALIDATION_ERROR', 'check start time is invalid');
  }

  const channel = loadScheduledChannel(database, channelId);
  const normalizedUrl = normalizeYouTubeChannelUrl(channel.url);
  const checkId = beginScheduledCheck(
    database,
    channel,
    startedAt.toISOString(),
  );

  let values: readonly unknown[];
  try {
    values = await fetchChannelEntries({
      executablePath: ytDlpExecutablePath,
      url: normalizedUrl,
      ...(channel.proxyUrl === undefined
        ? {}
        : { proxyUrl: channel.proxyUrl }),
    });
  } catch (error) {
    const businessError = new BusinessError(
      'CHANNEL_FETCH_FAILED',
      error instanceof Error ? error.message : 'channel fetch failed',
    );
    recordScheduledFailure(database, channel, checkId, businessError);
    throw businessError;
  }

  let entries: readonly PreparedEntry[];
  try {
    entries = await prepareEntries(
      values,
      startedAt,
      (url) =>
        fetchVideoMetadata({
          executablePath: ytDlpExecutablePath,
          url,
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
        : asChannelMetadataError('YouTube channel metadata is invalid');
    recordScheduledFailure(database, channel, checkId, businessError);
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
      .prepare('SELECT id FROM channels WHERE id = ?')
      .pluck()
      .get(channelId);
    if (existingChannel === undefined) {
      throw new BusinessError('CHANNEL_NOT_FOUND', 'channel not found');
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
             check_interval_minutes = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        channelInput.customName,
        customNameKey,
        channelInput.proxyId,
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
                (
                  SELECT d.status
                  FROM downloads d
                  WHERE d.video_id = v.id
                  ORDER BY d.created_at DESC, d.id DESC
                  LIMIT 1
                ) AS download_status
         FROM videos v
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
      downloadStatus: row.download_status,
    }));
  } catch (error) {
    if (error instanceof BusinessError) {
      throw error;
    }
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
      failureReason: row.failure_reason,
    }));
  } catch (error) {
    if (error instanceof BusinessError) {
      throw error;
    }
    throw persistenceError();
  }
}

export function recoverInterruptedChannelSyncs(
  database: DatabaseConnection,
  finishedAt = new Date().toISOString(),
): void {
  const reason = 'initial synchronization interrupted by restart';
  database.exec('BEGIN IMMEDIATE');
  try {
    database
      .prepare(
        `UPDATE channel_checks
         SET finished_at = ?, result = 'failed', failure_reason = ?
         WHERE kind = 'initial' AND finished_at IS NULL`,
      )
      .run(finishedAt, reason);
    database
      .prepare(
        `UPDATE channels
         SET initial_sync_status = 'failed', initial_sync_error = ?, updated_at = ?
         WHERE initial_sync_status = 'syncing'`,
      )
      .run(reason, finishedAt);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
