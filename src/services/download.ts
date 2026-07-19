import { basename } from 'node:path';

import type { DatabaseConnection } from '../db/client.js';
import { BusinessError } from '../errors.js';
import {
  assertVideoTargetAvailable,
  prepareChannelArchiveDirectory,
  resolveDirectDownloadDirectory,
  type ValidatedDownloadFile,
  validateDownloadFile,
  validateDownloadRoot,
} from '../filesystem.js';
import {
  parseYouTubeVideoMetadata,
  parseYouTubeVideoUrl,
} from '../youtube.js';
import { fetchVideoMetadata } from '../yt-dlp.js';

export interface Download {
  readonly id: number;
  readonly sourceType: 'channel' | 'direct';
  readonly title: string;
  readonly status: 'pending';
  readonly outputPath: null;
  readonly failureReason: null;
  readonly progressPercent: number | null;
  readonly speedText: string | null;
  readonly etaSeconds: number | null;
  readonly exitCode: number | null;
  readonly createdAt: string;
  readonly startedAt: null;
  readonly finishedAt: null;
  readonly networkMode: 'direct' | 'proxy';
  readonly proxyName: string | null;
}

export interface QueuedDownload {
  readonly downloadId: number;
  readonly sourceUrl: string;
  readonly platformVideoId: string;
  readonly targetDirectory: string;
  readonly downloadRoot: string;
  readonly downloadsMountPath: string;
  readonly proxyUrl?: string;
  readonly advancedOptions?: DownloadAdvancedOptions;
}

export interface DownloadQueue {
  enqueue(download: QueuedDownload): void;
  cancel?(downloadId: number): void;
}

export interface DownloadFile extends ValidatedDownloadFile {
  readonly filename: string;
}

export interface DownloadAdvancedOptions {
  readonly mediaType: 'video' | 'audio';
  readonly format: string | null;
  readonly quality: string | null;
  readonly codec: string | null;
  readonly writeSubtitles: boolean;
  readonly writeThumbnail: boolean;
  readonly splitChapters: boolean;
  readonly timeRangeStart: string | null;
  readonly timeRangeEnd: string | null;
  readonly filenamePreset: string | null;
}

interface DirectDownloadInput {
  readonly url: string;
  readonly proxyId: number | null;
  readonly targetSubdirectory: string | null;
  readonly advancedOptions: DownloadAdvancedOptions;
}

export type ChannelDownloadProxySelection = 'channel' | number | null;

interface ProxySelection {
  readonly networkMode: 'direct' | 'proxy';
  readonly proxyName: string | null;
  readonly proxyUrl?: string;
}

interface ChannelVideoRow {
  readonly video_id: number;
  readonly channel_id: number;
  readonly source_url: string;
  readonly platform_video_id: string;
  readonly title: string;
  readonly published_date: string;
  readonly custom_name: string;
  readonly proxy_id: number | null;
  readonly proxy_name: string | null;
  readonly proxy_url: string | null;
}

interface PreparedDownload {
  readonly sourceType: 'channel' | 'direct';
  readonly channelId: number | null;
  readonly videoId: number | null;
  readonly sourceUrl: string;
  readonly platformVideoId: string;
  readonly title: string;
  readonly publishedDate: string | null;
  readonly networkMode: 'direct' | 'proxy';
  readonly proxyName: string | null;
  readonly proxyUrl?: string;
  readonly targetSubdirectory: string | null;
  readonly advancedOptions: DownloadAdvancedOptions | null;
  readonly targetDirectory: string;
  readonly downloadRoot: string;
}

interface RetryDownloadRow {
  readonly id: number;
  readonly source_url: string;
  readonly platform_video_id: string;
  readonly target_subdirectory: string | null;
  readonly advanced_options_json: string | null;
  readonly proxy_url_snapshot: string | null;
}

function persistenceError(): BusinessError {
  return new BusinessError('PERSISTENCE_ERROR', 'download persistence failed');
}

function validateDownloadId(downloadId: number): void {
  if (!Number.isSafeInteger(downloadId) || downloadId < 1) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid download ID');
  }
}

function parseAdvancedOptionsJson(value: string | null): DownloadAdvancedOptions | undefined {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as DownloadAdvancedOptions;
  } catch {
    throw persistenceError();
  }
}

function validateVideoIds(videoIds: readonly number[]): void {
  if (videoIds.length === 0) {
    throw new BusinessError('VALIDATION_ERROR', 'video IDs must not be empty');
  }

  const uniqueIds = new Set<number>();
  for (const videoId of videoIds) {
    if (!Number.isSafeInteger(videoId) || videoId < 1) {
      throw new BusinessError('VALIDATION_ERROR', 'invalid video ID');
    }
    if (uniqueIds.has(videoId)) {
      throw new BusinessError('VALIDATION_ERROR', 'duplicate video IDs are not allowed');
    }
    uniqueIds.add(videoId);
  }
}

function parseOptionalString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim() !== value || value === '') {
    throw new BusinessError('VALIDATION_ERROR', 'invalid direct download input');
  }
  return value;
}

function parseAdvancedOptions(value: unknown): DownloadAdvancedOptions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid direct download input');
  }
  const keys = Object.keys(value);
  const required = [
    'mediaType',
    'format',
    'quality',
    'codec',
    'writeSubtitles',
    'writeThumbnail',
    'splitChapters',
    'timeRangeStart',
    'timeRangeEnd',
    'filenamePreset',
  ];
  if (keys.length !== required.length || required.some((key) => !keys.includes(key))) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid direct download input');
  }
  const record = value as Record<string, unknown>;
  if (
    record.mediaType !== 'video' &&
    record.mediaType !== 'audio'
  ) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid direct download input');
  }
  if (
    typeof record.writeSubtitles !== 'boolean' ||
    typeof record.writeThumbnail !== 'boolean' ||
    typeof record.splitChapters !== 'boolean'
  ) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid direct download input');
  }
  return {
    mediaType: record.mediaType,
    format: parseOptionalString(record.format),
    quality: parseOptionalString(record.quality),
    codec: parseOptionalString(record.codec),
    writeSubtitles: record.writeSubtitles,
    writeThumbnail: record.writeThumbnail,
    splitChapters: record.splitChapters,
    timeRangeStart: parseOptionalString(record.timeRangeStart),
    timeRangeEnd: parseOptionalString(record.timeRangeEnd),
    filenamePreset: parseOptionalString(record.filenamePreset),
  };
}

function parseDirectInput(input: unknown): DirectDownloadInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid direct download input');
  }
  const keys = Object.keys(input);
  if (
    keys.length !== 4 ||
    !keys.includes('url') ||
    !keys.includes('proxyId') ||
    !keys.includes('targetSubdirectory') ||
    !keys.includes('advancedOptions')
  ) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid direct download input');
  }

  const value = input as Record<string, unknown>;
  if (
    typeof value.url !== 'string' ||
    (value.proxyId !== null &&
      (!Number.isSafeInteger(value.proxyId) || (value.proxyId as number) < 1)) ||
    (value.targetSubdirectory !== null &&
      (typeof value.targetSubdirectory !== 'string' ||
        value.targetSubdirectory === ''))
  ) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid direct download input');
  }
  parseYouTubeVideoUrl(value.url);
  return {
    url: value.url,
    proxyId: value.proxyId as number | null,
    targetSubdirectory: value.targetSubdirectory as string | null,
    advancedOptions: parseAdvancedOptions(value.advancedOptions),
  };
}

function loadDownloadRoot(
  database: DatabaseConnection,
  downloadsMountPath: string,
): string {
  try {
    const downloadRoot = database
      .prepare('SELECT download_root FROM settings WHERE id = 1')
      .pluck()
      .get() as string | null | undefined;
    if (downloadRoot === undefined) {
      throw new Error('settings row is missing');
    }
    return downloadRoot ?? downloadsMountPath;
  } catch (error) {
    if (error instanceof BusinessError) {
      throw error;
    }
    throw persistenceError();
  }
}

function loadProxy(
  database: DatabaseConnection,
  proxyId: number | null,
): ProxySelection {
  if (proxyId === null) {
    return { networkMode: 'direct', proxyName: null };
  }

  try {
    const row = database
      .prepare('SELECT name, proxy_url FROM proxies WHERE id = ?')
      .get(proxyId) as { name: string; proxy_url: string } | undefined;
    if (row === undefined) {
      throw new BusinessError('PROXY_NOT_FOUND', 'proxy not found');
    }
    return {
      networkMode: 'proxy',
      proxyName: row.name,
      proxyUrl: row.proxy_url,
    };
  } catch (error) {
    if (error instanceof BusinessError) {
      throw error;
    }
    throw persistenceError();
  }
}

function loadChannelVideos(
  database: DatabaseConnection,
  videoIds: readonly number[],
): readonly ChannelVideoRow[] {
  try {
    const statement = database.prepare(
      `SELECT v.id AS video_id, v.channel_id, v.source_url,
              v.platform_video_id, v.title, v.published_date,
              c.custom_name, c.proxy_id, p.name AS proxy_name,
              p.proxy_url
       FROM videos v
       JOIN channels c ON c.id = v.channel_id
       LEFT JOIN proxies p ON p.id = c.proxy_id
       WHERE v.id = ?`,
    );
    return videoIds.map((videoId) => {
      const row = statement.get(videoId) as ChannelVideoRow | undefined;
      if (row === undefined) {
        throw new BusinessError('VIDEO_NOT_FOUND', 'video not found');
      }
      if (
        row.proxy_id !== null &&
        (row.proxy_name === null || row.proxy_url === null)
      ) {
        throw new BusinessError('PROXY_NOT_FOUND', 'proxy not found');
      }
      return row;
    });
  } catch (error) {
    if (error instanceof BusinessError) {
      throw error;
    }
    throw persistenceError();
  }
}

function assertNoExistingDownload(
  database: DatabaseConnection,
  platformVideoId: string,
): void {
  try {
    const existingId = database
      .prepare(
        `SELECT id FROM downloads
         WHERE platform = 'youtube' AND platform_video_id = ?
           AND status IN ('pending', 'downloading', 'completed')
         LIMIT 1`,
      )
      .pluck()
      .get(platformVideoId);
    if (existingId !== undefined) {
      throw new BusinessError(
        'DOWNLOAD_ALREADY_EXISTS',
        'a download for this video already exists',
      );
    }
  } catch (error) {
    if (error instanceof BusinessError) {
      throw error;
    }
    throw persistenceError();
  }
}

async function prepareChannelDownloads(
  database: DatabaseConnection,
  downloadsMountPath: string,
  videoIds: readonly number[],
  proxySelection: ChannelDownloadProxySelection,
): Promise<readonly PreparedDownload[]> {
  validateVideoIds(videoIds);
  const downloadRoot = await validateDownloadRoot(
    loadDownloadRoot(database, downloadsMountPath),
    downloadsMountPath,
  );
  const rows = loadChannelVideos(database, videoIds);
  const overrideProxy =
    proxySelection === 'channel' ? undefined : loadProxy(database, proxySelection);
  const downloads: PreparedDownload[] = [];

  for (const row of rows) {
    assertNoExistingDownload(database, row.platform_video_id);
    const publishedYear = Number(row.published_date.slice(0, 4));
    const targetDirectory = await prepareChannelArchiveDirectory(
      downloadRoot,
      downloadsMountPath,
      row.custom_name,
      publishedYear,
    );
    await assertVideoTargetAvailable(
      downloadRoot,
      downloadsMountPath,
      targetDirectory,
      row.platform_video_id,
    );
    const selectedProxy =
      overrideProxy ??
      (row.proxy_id === null
        ? { networkMode: 'direct' as const, proxyName: null }
        : {
            networkMode: 'proxy' as const,
            proxyName: row.proxy_name,
            proxyUrl: row.proxy_url as string,
          });
    downloads.push({
      sourceType: 'channel',
      channelId: row.channel_id,
      videoId: row.video_id,
      sourceUrl: row.source_url,
      platformVideoId: row.platform_video_id,
      title: row.title,
      publishedDate: row.published_date,
      networkMode: selectedProxy.networkMode,
      proxyName: selectedProxy.proxyName,
      ...(selectedProxy.proxyUrl === undefined
        ? {}
        : { proxyUrl: selectedProxy.proxyUrl }),
      targetSubdirectory: null,
      advancedOptions: null,
      targetDirectory,
      downloadRoot,
    });
  }
  return downloads;
}

function insertDownloads(
  database: DatabaseConnection,
  prepared: readonly PreparedDownload[],
  createdAt: string,
): Download[] {
  try {
    database.exec('BEGIN IMMEDIATE');
    const statement = database.prepare(
      `INSERT INTO downloads (
        source_type, channel_id, video_id, source_url, platform,
        platform_video_id, title, published_date, network_mode,
        proxy_name, proxy_url_snapshot, target_subdirectory, advanced_options_json,
        status, created_at
      ) VALUES (?, ?, ?, ?, 'youtube', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    );
    const downloads = prepared.map((value) => {
      assertNoExistingDownload(database, value.platformVideoId);
      const result = statement.run(
        value.sourceType,
        value.channelId,
        value.videoId,
        value.sourceUrl,
        value.platformVideoId,
        value.title,
        value.publishedDate,
        value.networkMode,
        value.proxyName,
        value.proxyUrl ?? null,
        value.targetSubdirectory,
        value.advancedOptions === null ? null : JSON.stringify(value.advancedOptions),
        createdAt,
      );
      return toDownload(Number(result.lastInsertRowid), value, createdAt);
    });
    database.exec('COMMIT');
    return downloads;
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

function toDownload(
  id: number,
  value: PreparedDownload,
  createdAt: string,
): Download {
  return {
    id,
    sourceType: value.sourceType,
    title: value.title,
    status: 'pending',
    outputPath: null,
    failureReason: null,
    progressPercent: null,
    speedText: null,
    etaSeconds: null,
    exitCode: null,
    createdAt,
    startedAt: null,
    finishedAt: null,
    networkMode: value.networkMode,
    proxyName: value.proxyName,
  };
}

function enqueueDownloads(
  queue: DownloadQueue,
  downloads: readonly Download[],
  prepared: readonly PreparedDownload[],
  downloadsMountPath: string,
): void {
  for (let index = 0; index < downloads.length; index += 1) {
    const download = downloads[index];
    const value = prepared[index];
    if (download === undefined || value === undefined) {
      throw new Error('download queue input is inconsistent');
    }
    queue.enqueue({
      downloadId: download.id,
      sourceUrl: value.sourceUrl,
      platformVideoId: value.platformVideoId,
      targetDirectory: value.targetDirectory,
      downloadRoot: value.downloadRoot,
      downloadsMountPath,
      ...(value.proxyUrl === undefined ? {} : { proxyUrl: value.proxyUrl }),
      ...(value.advancedOptions === null
        ? {}
        : { advancedOptions: value.advancedOptions }),
    });
  }
}

export async function createChannelDownloads(
  database: DatabaseConnection,
  downloadsMountPath: string,
  videoIds: readonly number[],
  queue: DownloadQueue,
  now = new Date(),
  proxySelection: ChannelDownloadProxySelection = 'channel',
): Promise<Download[]> {
  const prepared = await prepareChannelDownloads(
    database,
    downloadsMountPath,
    videoIds,
    proxySelection,
  );
  const createdAt = now.toISOString();
  const downloads = insertDownloads(database, prepared, createdAt);
  enqueueDownloads(
    queue,
    downloads,
    prepared,
    downloadsMountPath,
  );
  return downloads;
}

export async function createDirectDownload(
  database: DatabaseConnection,
  ytDlpExecutablePath: string,
  downloadsMountPath: string,
  input: unknown,
  queue: DownloadQueue,
  now = new Date(),
): Promise<Download> {
  const directInput = parseDirectInput(input);
  const parsedUrl = parseYouTubeVideoUrl(directInput.url);
  const downloadRoot = await validateDownloadRoot(
    loadDownloadRoot(database, downloadsMountPath),
    downloadsMountPath,
  );
  const targetDirectory = await resolveDirectDownloadDirectory(
    downloadRoot,
    downloadsMountPath,
    directInput.targetSubdirectory,
  );
  const proxy = loadProxy(database, directInput.proxyId);

  let rawMetadata: unknown;
  try {
    rawMetadata = await fetchVideoMetadata({
      executablePath: ytDlpExecutablePath,
      url: parsedUrl.url,
      ...(proxy.proxyUrl === undefined ? {} : { proxyUrl: proxy.proxyUrl }),
    });
  } catch (error) {
    throw new BusinessError(
      'VIDEO_FETCH_FAILED',
      error instanceof Error ? error.message : 'video fetch failed',
    );
  }
  const metadata = parseYouTubeVideoMetadata(
    rawMetadata,
    'VIDEO_METADATA_INVALID',
  );
  if (metadata.platformVideoId !== parsedUrl.videoId) {
    throw new BusinessError(
      'VIDEO_METADATA_INVALID',
      'YouTube metadata id does not match the requested video',
    );
  }

  assertNoExistingDownload(database, metadata.platformVideoId);
  await assertVideoTargetAvailable(
    downloadRoot,
    downloadsMountPath,
    targetDirectory,
    metadata.platformVideoId,
  );
  const prepared: PreparedDownload = {
    sourceType: 'direct',
    channelId: null,
    videoId: null,
    sourceUrl: directInput.url,
    platformVideoId: metadata.platformVideoId,
    title: metadata.title,
    publishedDate: null,
    networkMode: proxy.networkMode,
    proxyName: proxy.proxyName,
    ...(proxy.proxyUrl === undefined ? {} : { proxyUrl: proxy.proxyUrl }),
    targetSubdirectory: directInput.targetSubdirectory,
    advancedOptions: directInput.advancedOptions,
    targetDirectory,
    downloadRoot,
  };
  const createdAt = now.toISOString();
  const download = insertDownloads(database, [prepared], createdAt)[0];
  if (download === undefined) {
    throw persistenceError();
  }
  enqueueDownloads(
    queue,
    [download],
    [prepared],
    downloadsMountPath,
  );
  return download;
}

export async function getDownloadFile(
  database: DatabaseConnection,
  downloadsMountPath: string,
  downloadId: number,
): Promise<DownloadFile> {
  validateDownloadId(downloadId);
  let row: { status: string; output_path: string | null } | undefined;
  try {
    row = database
      .prepare('SELECT status, output_path FROM downloads WHERE id = ?')
      .get(downloadId) as
      | { status: string; output_path: string | null }
      | undefined;
  } catch {
    throw persistenceError();
  }
  if (row === undefined) {
    throw new BusinessError('DOWNLOAD_NOT_FOUND', 'download not found');
  }
  if (row.status !== 'completed' || row.output_path === null) {
    throw new BusinessError(
      'DOWNLOAD_FILE_UNAVAILABLE',
      'download file unavailable',
    );
  }

  const file = await validateDownloadFile(
    loadDownloadRoot(database, downloadsMountPath),
    downloadsMountPath,
    row.output_path,
  );
  return { ...file, filename: basename(file.path) };
}

export async function cancelDownload(
  database: DatabaseConnection,
  downloadId: number,
  queue: DownloadQueue,
  now = new Date(),
): Promise<void> {
  validateDownloadId(downloadId);
  if (!Number.isFinite(now.getTime())) {
    throw new BusinessError('VALIDATION_ERROR', 'cancel time is invalid');
  }
  try {
    const exists = database
      .prepare('SELECT id FROM downloads WHERE id = ?')
      .pluck()
      .get(downloadId);
    if (exists === undefined) {
      throw new BusinessError('DOWNLOAD_NOT_FOUND', 'download not found');
    }
    const result = database
      .prepare(
        `UPDATE downloads
         SET status = 'canceled', failure_reason = ?, finished_at = ?
         WHERE id = ? AND status IN ('pending', 'running', 'downloading')`,
      )
      .run('download canceled by user', now.toISOString(), downloadId);
    if (result.changes === 1) {
      queue.cancel?.(downloadId);
    }
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    throw persistenceError();
  }
}

export async function deleteDownload(
  database: DatabaseConnection,
  downloadId: number,
): Promise<void> {
  validateDownloadId(downloadId);
  try {
    const result = database
      .prepare(
        `DELETE FROM downloads
         WHERE id = ? AND status IN ('completed', 'failed', 'canceled', 'interrupted')`,
      )
      .run(downloadId);
    if (result.changes !== 1) {
      const exists = database
        .prepare('SELECT id FROM downloads WHERE id = ?')
        .pluck()
        .get(downloadId);
      if (exists === undefined) {
        throw new BusinessError('DOWNLOAD_NOT_FOUND', 'download not found');
      }
      throw new BusinessError('VALIDATION_ERROR', 'download is not deletable');
    }
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    throw persistenceError();
  }
}

export async function retryDownload(
  database: DatabaseConnection,
  downloadsMountPath: string,
  downloadId: number,
  queue: DownloadQueue,
  now = new Date(),
): Promise<void> {
  validateDownloadId(downloadId);
  if (!Number.isFinite(now.getTime())) {
    throw new BusinessError('VALIDATION_ERROR', 'retry time is invalid');
  }
  try {
    const row = database
      .prepare(
        `SELECT id, source_url, platform_video_id, target_subdirectory,
                advanced_options_json, proxy_url_snapshot
         FROM downloads
         WHERE id = ? AND status IN ('failed', 'canceled', 'interrupted')`,
      )
      .get(downloadId) as RetryDownloadRow | undefined;
    if (row === undefined) {
      const exists = database
        .prepare('SELECT id FROM downloads WHERE id = ?')
        .pluck()
        .get(downloadId);
      if (exists === undefined) {
        throw new BusinessError('DOWNLOAD_NOT_FOUND', 'download not found');
      }
      throw new BusinessError('VALIDATION_ERROR', 'download is not retryable');
    }
    const downloadRoot = await validateDownloadRoot(
      loadDownloadRoot(database, downloadsMountPath),
      downloadsMountPath,
    );
    const targetDirectory = await resolveDirectDownloadDirectory(
      downloadRoot,
      downloadsMountPath,
      row.target_subdirectory,
    );
    const updated = database
      .prepare(
        `UPDATE downloads
         SET status = 'pending', output_path = NULL, failure_reason = NULL,
             started_at = NULL, finished_at = NULL, created_at = ?
         WHERE id = ?`,
      )
      .run(now.toISOString(), downloadId);
    if (updated.changes !== 1) {
      throw new Error('download is missing');
    }
    const retryJob: QueuedDownload = {
      downloadId,
      sourceUrl: row.source_url,
      platformVideoId: row.platform_video_id,
      targetDirectory,
      downloadRoot,
      downloadsMountPath,
      ...(row.proxy_url_snapshot === null
        ? {}
        : { proxyUrl: row.proxy_url_snapshot }),
    };
    const advancedOptions = parseAdvancedOptionsJson(row.advanced_options_json);
    queue.enqueue(
      advancedOptions === undefined
        ? retryJob
        : { ...retryJob, advancedOptions },
    );
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    throw persistenceError();
  }
}
