import {
  access,
  constants,
  mkdir,
  open,
  readdir,
  realpath,
  stat,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { BusinessError } from './errors.js';

const CHANNEL_NAME_ERROR = 'invalid channel name';
const PATH_OUTSIDE_ROOT_ERROR = 'path is outside download root';
const ROOT_UNAVAILABLE_ERROR =
  'download root is not readable, writable, and enterable';
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isArchiveVideoId(value: unknown): value is string {
  return typeof value === 'string' && VIDEO_ID_PATTERN.test(value);
}

function isContained(basePath: string, candidatePath: string): boolean {
  const relativePath = relative(basePath, candidatePath);
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function assertContained(
  mountPath: string,
  downloadRoot: string,
  candidatePath: string,
): void {
  if (
    !isContained(mountPath, candidatePath) ||
    !isContained(downloadRoot, candidatePath)
  ) {
    throw new BusinessError('VALIDATION_ERROR', PATH_OUTSIDE_ROOT_ERROR);
  }
}

async function realDirectory(path: string): Promise<string> {
  const realPath = await realpath(path);
  const pathStat = await stat(realPath);
  if (!pathStat.isDirectory()) {
    throw new Error('path is not a directory');
  }
  return realPath;
}

async function validateExistingDirectory(
  path: string,
  mountPath: string,
  downloadRoot: string,
): Promise<string> {
  const resolvedPath = resolve(path);

  let realPath: string;
  try {
    realPath = await realDirectory(resolvedPath);
  } catch {
    throw new BusinessError('VALIDATION_ERROR', 'path is not an available directory');
  }

  assertContained(mountPath, downloadRoot, realPath);
  return realPath;
}

async function createArchiveDirectory(
  path: string,
  mountPath: string,
  downloadRoot: string,
): Promise<string> {
  const resolvedPath = resolve(path);
  assertContained(mountPath, downloadRoot, resolvedPath);

  try {
    await mkdir(resolvedPath);
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'EEXIST'
    ) {
      throw new BusinessError(
        'VALIDATION_ERROR',
        'archive directory is unavailable',
      );
    }
  }

  const realPath = await validateExistingDirectory(
    resolvedPath,
    mountPath,
    downloadRoot,
  );
  try {
    await access(realPath, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    throw new BusinessError(
      'VALIDATION_ERROR',
      'archive directory is unavailable',
    );
  }
  return realPath;
}

export function validateChannelName(customName: string): string {
  if (
    customName.length === 0 ||
    customName.trim() !== customName ||
    customName.normalize('NFC') !== customName ||
    customName === '.' ||
    customName === '..' ||
    customName.includes('/') ||
    customName.includes('\\') ||
    /[\p{Cc}\p{Cs}]/u.test(customName) ||
    Array.from(customName).length > 80 ||
    Buffer.byteLength(customName, 'utf8') > 255
  ) {
    throw new BusinessError('VALIDATION_ERROR', CHANNEL_NAME_ERROR);
  }

  return customName;
}

export async function validateDownloadRoot(
  downloadRoot: string,
  downloadsMountPath: string,
): Promise<string> {
  if (!isAbsolute(downloadRoot) || !isAbsolute(downloadsMountPath)) {
    throw new BusinessError('VALIDATION_ERROR', 'download root must be absolute');
  }

  let realMountPath: string;
  let realDownloadRoot: string;
  try {
    realMountPath = await realDirectory(resolve(downloadsMountPath));
    realDownloadRoot = await realDirectory(resolve(downloadRoot));
  } catch {
    throw new BusinessError('DOWNLOAD_ROOT_UNAVAILABLE', ROOT_UNAVAILABLE_ERROR);
  }

  if (!isContained(realMountPath, realDownloadRoot)) {
    throw new BusinessError(
      'DOWNLOAD_ROOT_OUTSIDE_MOUNT',
      'download root is outside downloads mount',
    );
  }

  try {
    await access(
      realDownloadRoot,
      constants.R_OK | constants.W_OK | constants.X_OK,
    );
  } catch {
    throw new BusinessError('DOWNLOAD_ROOT_UNAVAILABLE', ROOT_UNAVAILABLE_ERROR);
  }

  return realDownloadRoot;
}

export interface ValidatedDownloadFile {
  readonly path: string;
  readonly handle: FileHandle;
  readonly size: number;
}

export async function validateDownloadFile(
  downloadRoot: string,
  downloadsMountPath: string,
  outputPath: string,
): Promise<ValidatedDownloadFile> {
  const realDownloadRoot = await validateDownloadRoot(
    downloadRoot,
    downloadsMountPath,
  );
  const realMountPath = await realDirectory(resolve(downloadsMountPath));

  let handle: FileHandle | undefined;
  try {
    const realFilePath = await realpath(resolve(outputPath));
    const fileStat = await stat(realFilePath);
    assertContained(realMountPath, realDownloadRoot, realFilePath);
    if (!fileStat.isFile()) throw new Error('path is not a regular file');
    await access(realFilePath, constants.R_OK);
    handle = await open(
      realFilePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.dev !== fileStat.dev ||
      openedStat.ino !== fileStat.ino
    ) {
      throw new Error('opened file changed after validation');
    }
    return { path: realFilePath, handle, size: openedStat.size };
  } catch {
    await handle?.close().catch(() => undefined);
    throw new BusinessError(
      'DOWNLOAD_FILE_UNAVAILABLE',
      'download file unavailable',
    );
  }
}

export async function prepareChannelArchiveDirectory(
  downloadRoot: string,
  downloadsMountPath: string,
  customName: string,
  publishedYear: number,
): Promise<string> {
  const realDownloadRoot = await validateDownloadRoot(
    downloadRoot,
    downloadsMountPath,
  );
  const realMountPath = await realDirectory(resolve(downloadsMountPath));
  validateChannelName(customName);

  if (
    !Number.isInteger(publishedYear) ||
    publishedYear < 1000 ||
    publishedYear > 9999
  ) {
    throw new BusinessError(
      'VALIDATION_ERROR',
      'published year must be four digits',
    );
  }

  const channelDirectory = await createArchiveDirectory(
    resolve(realDownloadRoot, customName),
    realMountPath,
    realDownloadRoot,
  );
  return createArchiveDirectory(
    resolve(channelDirectory, String(publishedYear)),
    realMountPath,
    realDownloadRoot,
  );
}

export async function resolveDirectDownloadDirectory(
  downloadRoot: string,
  downloadsMountPath: string,
  targetSubdirectory: string | null = null,
): Promise<string> {
  const realDownloadRoot = await validateDownloadRoot(
    downloadRoot,
    downloadsMountPath,
  );
  if (targetSubdirectory === null) {
    return realDownloadRoot;
  }
  if (
    targetSubdirectory === '' ||
    targetSubdirectory.trim() !== targetSubdirectory ||
    isAbsolute(targetSubdirectory) ||
    targetSubdirectory.split(/[\\/]/u).some((part) => part === '' || part === '.' || part === '..') ||
    /[\p{Cc}\p{Cs}]/u.test(targetSubdirectory)
  ) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid target subdirectory');
  }

  const realMountPath = await realDirectory(resolve(downloadsMountPath));
  return createArchiveDirectory(
    resolve(realDownloadRoot, targetSubdirectory),
    realMountPath,
    realDownloadRoot,
  );
}

export async function assertVideoTargetAvailable(
  downloadRoot: string,
  downloadsMountPath: string,
  targetDirectory: string,
  videoId: string,
): Promise<void> {
  if (!isArchiveVideoId(videoId)) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid video ID');
  }

  const realDownloadRoot = await validateDownloadRoot(
    downloadRoot,
    downloadsMountPath,
  );
  const realMountPath = await realDirectory(resolve(downloadsMountPath));
  const realTargetDirectory = await validateExistingDirectory(
    targetDirectory,
    realMountPath,
    realDownloadRoot,
  );
  const entries = await readdir(realTargetDirectory);

  for (const entry of entries) {
    if (!entry.startsWith(`${videoId}.`)) {
      continue;
    }

    let realEntryPath: string;
    try {
      realEntryPath = await realpath(resolve(realTargetDirectory, entry));
    } catch {
      throw new BusinessError('VALIDATION_ERROR', 'target path is unavailable');
    }
    assertContained(realMountPath, realDownloadRoot, realEntryPath);

    if ((await stat(realEntryPath)).isFile()) {
      throw new BusinessError(
        'DOWNLOAD_ALREADY_EXISTS',
        'a target file for this video already exists',
      );
    }
  }
}
