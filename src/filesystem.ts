import {
  access,
  constants,
  open,
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
