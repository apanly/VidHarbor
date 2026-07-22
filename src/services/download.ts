import { mkdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { DatabaseConnection } from '../db/client.js';
import { BusinessError } from '../errors.js';
import {
  isArchiveVideoId,
  type ValidatedDownloadFile,
  validateDownloadFile,
  validateDownloadRoot,
} from '../filesystem.js';
import type { YtDlpTaskManager } from '../yt-dlp-task-manager.js';

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
  readonly durationSeconds: number | null;
}

export interface QueuedDownload {
  readonly downloadId: number;
  readonly sourceUrl: string;
  readonly platformVideoId: string;
  readonly downloadRoot: string;
  readonly downloadsMountPath: string;
  readonly proxyUrl?: string;
  readonly advancedOptions?: DownloadAdvancedOptions;
}

export interface DownloadQueue {
  enqueue(download: QueuedDownload): void;
  cancel(downloadId: number): Promise<void>;
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
  readonly splitChapters: boolean;
  readonly timeRangeStart: string | null;
  readonly timeRangeEnd: string | null;
}

interface DirectDownloadInput {
  readonly url: string;
  readonly proxyId: number | null;
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
  readonly platform: 'youtube' | 'bilibili';
  readonly platform_video_id: string;
  readonly title: string;
  readonly published_date: string;
  readonly duration_seconds: number | null;
  readonly proxy_id: number | null;
  readonly proxy_name: string | null;
  readonly proxy_url: string | null;
}

interface PreparedDownload {
  readonly sourceType: 'channel' | 'direct';
  readonly channelId: number | null;
  readonly videoId: number | null;
  readonly sourceUrl: string;
  readonly platform: string;
  readonly platformVideoId: string;
  readonly title: string;
  readonly publishedDate: string | null;
  readonly durationSeconds: number | null;
  readonly networkMode: 'direct' | 'proxy';
  readonly proxyName: string | null;
  readonly proxyUrl?: string;
  readonly advancedOptions: DownloadAdvancedOptions | null;
  readonly downloadRoot: string;
}

interface RetryDownloadRow {
  readonly id: number;
  readonly source_url: string;
  readonly platform_video_id: string;
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
    'splitChapters',
    'timeRangeStart',
    'timeRangeEnd',
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
    splitChapters: record.splitChapters,
    timeRangeStart: parseOptionalString(record.timeRangeStart),
    timeRangeEnd: parseOptionalString(record.timeRangeEnd),
  };
}

function parseDirectInput(input: unknown): DirectDownloadInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid direct download input');
  }
  const keys = Object.keys(input);
  if (
    keys.length !== 3 ||
    !keys.includes('url') ||
    !keys.includes('proxyId') ||
    !keys.includes('advancedOptions')
  ) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid direct download input');
  }

  const value = input as Record<string, unknown>;
  if (
    typeof value.url !== 'string' ||
    (value.proxyId !== null &&
      (!Number.isSafeInteger(value.proxyId) || (value.proxyId as number) < 1))
  ) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid direct download input');
  }
  validateDirectUrl(value.url);
  return {
    url: value.url,
    proxyId: value.proxyId as number | null,
    advancedOptions: parseAdvancedOptions(value.advancedOptions),
  };
}

function validateDirectUrl(value: string): void {
  if (value === '' || value.trim() !== value || !value.startsWith('https://')) {
    throw new BusinessError('NOT_A_VIDEO_URL', 'URL must be an HTTPS URL');
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname === '') throw new Error();
  } catch {
    throw new BusinessError('NOT_A_VIDEO_URL', 'URL must be an HTTPS URL');
  }
}

function parseDirectVideoMetadata(value: unknown): {
  readonly platform: string;
  readonly platformVideoId: string;
  readonly title: string;
  readonly durationSeconds: number | null;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BusinessError('VIDEO_METADATA_INVALID', 'video metadata must be an object');
  }
  const metadata = value as Record<string, unknown>;
  if (
    typeof metadata.extractor_key !== 'string' ||
    metadata.extractor_key === '' ||
    metadata.extractor_key.trim() !== metadata.extractor_key
  ) {
    throw new BusinessError('VIDEO_METADATA_INVALID', 'video metadata extractor_key is required');
  }
  if (!isArchiveVideoId(metadata.id)) {
    throw new BusinessError('VIDEO_METADATA_INVALID', 'video metadata id is invalid');
  }
  if (typeof metadata.title !== 'string' || metadata.title.trim() === '') {
    throw new BusinessError('VIDEO_METADATA_INVALID', 'video metadata title is required');
  }
  if (metadata.duration !== undefined && (
    typeof metadata.duration !== 'number' ||
    !Number.isFinite(metadata.duration) ||
    metadata.duration < 0 ||
    !Number.isSafeInteger(Math.ceil(metadata.duration))
  )) {
    throw new BusinessError('VIDEO_METADATA_INVALID', 'video metadata duration is invalid');
  }
  return {
    platform: metadata.extractor_key.toLowerCase(),
    platformVideoId: metadata.id,
    title: metadata.title,
    durationSeconds: metadata.duration === undefined ? null : Math.ceil(metadata.duration),
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
      `SELECT v.id AS video_id, v.channel_id, v.source_url, v.platform,
              v.platform_video_id, v.title, v.published_date,
              v.duration_seconds, c.proxy_id, p.name AS proxy_name,
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
  platform: string,
  platformVideoId: string,
): void {
  try {
    const existingId = database
      .prepare(
        `SELECT id FROM downloads
         WHERE platform = ? AND platform_video_id = ?
           AND status IN ('pending', 'downloading', 'running', 'completed', 'deleting')
         LIMIT 1`,
      )
      .pluck()
      .get(platform, platformVideoId);
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
    assertNoExistingDownload(database, row.platform, row.platform_video_id);
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
      platform: row.platform,
      platformVideoId: row.platform_video_id,
      title: row.title,
      publishedDate: row.published_date,
      durationSeconds: row.duration_seconds,
      networkMode: selectedProxy.networkMode,
      proxyName: selectedProxy.proxyName,
      ...(selectedProxy.proxyUrl === undefined
        ? {}
        : { proxyUrl: selectedProxy.proxyUrl }),
      advancedOptions: null,
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
        platform_video_id, title, published_date, duration_seconds, network_mode,
        proxy_name, proxy_url_snapshot, target_subdirectory, advanced_options_json,
        archive_layout, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'download_directory', 'pending', ?)`,
    );
    const downloads = prepared.map((value) => {
      assertNoExistingDownload(database, value.platform, value.platformVideoId);
      const result = statement.run(
        value.sourceType,
        value.channelId,
        value.videoId,
        value.sourceUrl,
        value.platform,
        value.platformVideoId,
        value.title,
        value.publishedDate,
        value.durationSeconds,
        value.networkMode,
        value.proxyName,
        value.proxyUrl ?? null,
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
    durationSeconds: value.durationSeconds,
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
  taskManager: YtDlpTaskManager,
  downloadsMountPath: string,
  input: unknown,
  queue: DownloadQueue,
  now = new Date(),
): Promise<Download> {
  const directInput = parseDirectInput(input);
  const downloadRoot = await validateDownloadRoot(
    loadDownloadRoot(database, downloadsMountPath),
    downloadsMountPath,
  );
  const proxy = loadProxy(database, directInput.proxyId);

  let rawMetadata: unknown;
  try {
    rawMetadata = await taskManager.submit({
      type: 'metadata_probe',
      execute: (operations) => operations.fetchVideoMetadata({
        url: directInput.url,
        ...(proxy.proxyUrl === undefined ? {} : { proxyUrl: proxy.proxyUrl }),
      }),
    }).result;
  } catch (error) {
    throw new BusinessError(
      'VIDEO_FETCH_FAILED',
      error instanceof Error ? error.message : 'video fetch failed',
    );
  }
  const metadata = parseDirectVideoMetadata(rawMetadata);

  assertNoExistingDownload(database, metadata.platform, metadata.platformVideoId);
  const prepared: PreparedDownload = {
    sourceType: 'direct',
    channelId: null,
    videoId: null,
    sourceUrl: directInput.url,
    platform: metadata.platform,
    platformVideoId: metadata.platformVideoId,
    title: metadata.title,
    publishedDate: null,
    durationSeconds: metadata.durationSeconds,
    networkMode: proxy.networkMode,
    proxyName: proxy.proxyName,
    ...(proxy.proxyUrl === undefined ? {} : { proxyUrl: proxy.proxyUrl }),
    advancedOptions: directInput.advancedOptions,
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

export async function getDownloadThumbnail(
  database: DatabaseConnection,
  downloadsMountPath: string,
  downloadId: number,
): Promise<DownloadFile> {
  validateDownloadId(downloadId);
  let path: string | null | undefined;
  try {
    path = database
      .prepare("SELECT thumbnail_path FROM downloads WHERE id = ? AND status = 'completed'")
      .pluck()
      .get(downloadId) as string | null | undefined;
  } catch {
    throw persistenceError();
  }
  if (path === undefined) throw new BusinessError('DOWNLOAD_NOT_FOUND', 'download not found');
  if (path === null) {
    throw new BusinessError('DOWNLOAD_FILE_UNAVAILABLE', 'download thumbnail unavailable');
  }
  const file = await validateDownloadFile(
    loadDownloadRoot(database, downloadsMountPath),
    downloadsMountPath,
    path,
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
         SET status = 'canceled', failure_reason = ?, speed_text = NULL,
             eta_seconds = NULL, finished_at = ?
         WHERE id = ? AND status IN ('pending', 'running', 'downloading')`,
      )
      .run('download canceled by user', now.toISOString(), downloadId);
    if (result.changes === 1) {
      await queue.cancel(downloadId);
    }
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    throw persistenceError();
  }
}

const DELETE_QUARANTINE_DIRECTORY = '.vidharbor-delete';

interface DeletingDownloadRow {
  readonly id: number;
  readonly status: string;
  readonly output_path: string | null;
  readonly archive_layout: string;
}

function deleteQuarantinePath(downloadRoot: string, downloadId: number): string {
  return join(downloadRoot, DELETE_QUARANTINE_DIRECTORY, String(downloadId));
}

/** Returns true only when this caller owns the completed -> deleting transition. */
function tryMarkDownloadDeleting(
  database: DatabaseConnection,
  downloadId: number,
): boolean {
  try {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = database
        .prepare(
          `UPDATE downloads
           SET status = 'deleting'
           WHERE id = ? AND status = 'completed'`,
        )
        .run(downloadId);
      database.exec('COMMIT');
      return result.changes === 1;
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // The transaction may not have started.
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    throw persistenceError();
  }
}

function deleteInProgressError(): BusinessError {
  return new BusinessError(
    'DOWNLOAD_DELETE_IN_PROGRESS',
    'download deletion is already in progress',
  );
}

function restoreDownloadToCompleted(
  database: DatabaseConnection,
  downloadId: number,
): void {
  try {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = database
        .prepare(
          `UPDATE downloads
           SET status = 'completed'
           WHERE id = ? AND status = 'deleting'`,
        )
        .run(downloadId);
      if (result.changes !== 1) {
        throw new Error('download is not deleting');
      }
      database.exec('COMMIT');
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // The transaction may not have started.
      }
      throw error;
    }
  } catch {
    throw persistenceError();
  }
}

function hardDeleteDeletingRow(
  database: DatabaseConnection,
  downloadId: number,
): void {
  try {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = database
        .prepare("DELETE FROM downloads WHERE id = ? AND status = 'deleting'")
        .run(downloadId);
      if (result.changes !== 1) {
        throw new Error('download is not deleting');
      }
      database.exec('COMMIT');
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // The transaction may not have started.
      }
      throw error;
    }
  } catch {
    throw persistenceError();
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

/** true if path resolves; false only for ENOENT; any other FS error fails closed. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await realpath(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw new BusinessError(
      'DOWNLOAD_DELETE_FAILED',
      'download file deletion failed',
    );
  }
}

/**
 * Prove the persisted main media path is still a readable non-empty regular file
 * under the download root. Used before restoring `completed` after a failed delete.
 */
async function mainMediaIsIntact(
  downloadRoot: string,
  downloadsMountPath: string,
  outputPath: string,
): Promise<boolean> {
  try {
    const file = await validateDownloadFile(
      downloadRoot,
      downloadsMountPath,
      outputPath,
    );
    const intact = file.size > 0;
    await file.handle.close().catch(() => undefined);
    return intact;
  } catch {
    return false;
  }
}

/**
 * Converge a row already marked `deleting`: remove archive media, then hard-delete
 * the row. On media failure, restore to `completed` only when the main media at
 * the persisted output_path is still a non-empty regular file; otherwise keep
 * `deleting` for startup recovery. SQLite transactions stay fully synchronous.
 */
async function finalizeDeletingDownload(
  database: DatabaseConnection,
  downloadsMountPath: string,
  row: DeletingDownloadRow,
): Promise<void> {
  if (row.status !== 'deleting' || row.output_path === null) {
    throw persistenceError();
  }

  const configuredRoot = loadDownloadRoot(database, downloadsMountPath);
  const realDownloadRoot = await validateDownloadRoot(
    configuredRoot,
    downloadsMountPath,
  );
  const quarantinePath = deleteQuarantinePath(realDownloadRoot, row.id);
  let originalArchivePath: string;

  if (row.archive_layout === 'download_directory') {
    originalArchivePath = join(realDownloadRoot, String(row.id));
  } else if (row.archive_layout === 'legacy_file') {
    originalArchivePath = row.output_path;
  } else {
    throw persistenceError();
  }

  const originalExists = await pathExists(originalArchivePath);
  const quarantineExists = await pathExists(quarantinePath);

  if (!originalExists && !quarantineExists) {
    // Files already removed; only the persistent deleting marker remains.
    hardDeleteDeletingRow(database, row.id);
    return;
  }

  const quarantineParent = join(realDownloadRoot, DELETE_QUARANTINE_DIRECTORY);
  try {
    if (originalExists && !quarantineExists) {
      await mkdir(quarantineParent, { recursive: true });
      await rename(originalArchivePath, quarantinePath);
    }
    await rm(quarantinePath, { recursive: true, force: true });
    // Only remove the shared parent when empty; other deletes may use it concurrently.
    await rmdir(quarantineParent).catch(() => undefined);
  } catch {
    if (await pathExists(quarantinePath) && !(await pathExists(originalArchivePath))) {
      try {
        await rename(quarantinePath, originalArchivePath);
      } catch {
        // Leave status as deleting so startup can retry cleanup.
        throw new BusinessError(
          'DOWNLOAD_DELETE_FAILED',
          'download file deletion failed',
        );
      }
    }
    await rmdir(quarantineParent).catch(() => undefined);

    // Recursive rm is not atomic: restore completed only when main media still
    // exists at the persisted output_path as a non-empty regular file.
    if (
      await mainMediaIsIntact(configuredRoot, downloadsMountPath, row.output_path)
    ) {
      restoreDownloadToCompleted(database, row.id);
    }
    throw new BusinessError('DOWNLOAD_DELETE_FAILED', 'download file deletion failed');
  }

  hardDeleteDeletingRow(database, row.id);
}

export async function recoverDeletingDownloads(
  database: DatabaseConnection,
  downloadsMountPath: string,
): Promise<void> {
  const rows = database
    .prepare(
      `SELECT id, status, output_path, archive_layout
       FROM downloads
       WHERE status = 'deleting'
       ORDER BY id`,
    )
    .all() as DeletingDownloadRow[];
  for (const row of rows) {
    await finalizeDeletingDownload(database, downloadsMountPath, row);
  }
}

export async function deleteDownload(
  database: DatabaseConnection,
  downloadsMountPath: string,
  downloadId: number,
): Promise<void> {
  validateDownloadId(downloadId);
  let row: DeletingDownloadRow | undefined;
  try {
    row = database
      .prepare(
        'SELECT id, status, output_path, archive_layout FROM downloads WHERE id = ?',
      )
      .get(downloadId) as DeletingDownloadRow | undefined;
  } catch {
    throw persistenceError();
  }
  if (row === undefined) {
    throw new BusinessError('DOWNLOAD_NOT_FOUND', 'download not found');
  }

  if (row.status === 'deleting') {
    // Only the request that won completed -> deleting may touch files.
    // Startup recovery remains the sole non-HTTP owner of leftover deleting rows.
    throw deleteInProgressError();
  }

  if (!['completed', 'failed', 'canceled', 'interrupted'].includes(row.status)) {
    throw new BusinessError('VALIDATION_ERROR', 'download is not deletable');
  }

  if (row.status !== 'completed') {
    try {
      const result = database.prepare('DELETE FROM downloads WHERE id = ?').run(downloadId);
      if (result.changes !== 1) throw new Error('download is missing');
      return;
    } catch {
      throw persistenceError();
    }
  }
  if (row.output_path === null) throw persistenceError();

  // Prove the archive is still reachable before entering the durable deleting state.
  const downloadRoot = loadDownloadRoot(database, downloadsMountPath);
  const file = await validateDownloadFile(
    downloadRoot,
    downloadsMountPath,
    row.output_path,
  );
  if (row.archive_layout === 'download_directory') {
    const expectedDirectory = join(
      await validateDownloadRoot(downloadRoot, downloadsMountPath),
      String(downloadId),
    );
    const actualDirectory = await realpath(dirname(file.path)).catch(() => undefined);
    await file.handle.close().catch(() => undefined);
    if (actualDirectory !== expectedDirectory) {
      throw new BusinessError('DOWNLOAD_DELETE_FAILED', 'download directory is invalid');
    }
  } else if (row.archive_layout === 'legacy_file') {
    await file.handle.close().catch(() => undefined);
  } else {
    await file.handle.close().catch(() => undefined);
    throw persistenceError();
  }

  if (!tryMarkDownloadDeleting(database, downloadId)) {
    // Another request claimed the transition or the row left completed concurrently.
    const current = database
      .prepare('SELECT status FROM downloads WHERE id = ?')
      .pluck()
      .get(downloadId) as string | undefined;
    if (current === 'deleting') throw deleteInProgressError();
    if (current === undefined) {
      throw new BusinessError('DOWNLOAD_NOT_FOUND', 'download not found');
    }
    throw new BusinessError('VALIDATION_ERROR', 'download is not deletable');
  }

  await finalizeDeletingDownload(database, downloadsMountPath, {
    id: downloadId,
    status: 'deleting',
    output_path: row.output_path,
    archive_layout: row.archive_layout,
  });
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
        `SELECT id, source_url, platform_video_id, advanced_options_json, proxy_url_snapshot
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
    const updated = database
      .prepare(
        `UPDATE downloads
         SET status = 'pending', output_path = NULL, thumbnail_path = NULL,
             output_size_bytes = NULL,
             archive_layout = 'download_directory', failure_reason = NULL,
             progress_percent = NULL, speed_text = NULL, eta_seconds = NULL,
             exit_code = NULL, started_at = NULL, finished_at = NULL,
             created_at = ?
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
