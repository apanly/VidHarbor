import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

import { BusinessError } from '../errors.js';

export const COOKIE_PLATFORMS = [
  {
    platform: 'youtube',
    fileName: 'youtube.cookies.txt',
    temporaryFileName: '.youtube.cookies.txt.pending',
  },
  {
    platform: 'bilibili',
    fileName: 'bilibili.cookies.txt',
    temporaryFileName: '.bilibili.cookies.txt.pending',
  },
  {
    platform: 'x',
    fileName: 'x.cookies.txt',
    temporaryFileName: '.x.cookies.txt.pending',
  },
  {
    platform: 'facebook',
    fileName: 'facebook.cookies.txt',
    temporaryFileName: '.facebook.cookies.txt.pending',
  },
  {
    platform: 'douyin',
    fileName: 'douyin.cookies.txt',
    temporaryFileName: '.douyin.cookies.txt.pending',
  },
] as const;

export type CookiePlatform = (typeof COOKIE_PLATFORMS)[number]['platform'];

export interface CookieConfiguration {
  readonly platform: CookiePlatform;
  readonly configured: boolean;
  readonly updatedAt: string | null;
}

type PlatformDefinition = (typeof COOKIE_PLATFORMS)[number];
type QueueTail = Promise<void>;

const HTTP_ONLY_PREFIX = Buffer.from('#HttpOnly_', 'ascii');
const EMPTY_FILE_MESSAGE = 'cookie file is empty';
const INVALID_FILE_MESSAGE = 'invalid Netscape cookie file';

class CookieFileValidationError extends Error {
  constructor(readonly kind: 'empty' | 'invalid') {
    super(kind);
  }
}

function persistenceError(): BusinessError {
  return new BusinessError('PERSISTENCE_ERROR', 'cookie persistence failed');
}

function validationError(message: string): BusinessError {
  return new BusinessError('VALIDATION_ERROR', message);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function getPlatformDefinition(platform: string): PlatformDefinition {
  const definition = COOKIE_PLATFORMS.find(
    (candidate) => candidate.platform === platform,
  );
  if (definition === undefined) {
    throw validationError('invalid cookie platform');
  }
  return definition;
}

export function isCookiePlatform(platform: string): platform is CookiePlatform {
  return COOKIE_PLATFORMS.some(
    (definition) => definition.platform === platform,
  );
}

class NetscapeCookieValidator {
  private lineStarted = false;
  private lineIsWhitespace = true;
  private lineKind: 'undecided' | 'comment' | 'data' = 'undecided';
  private httpOnlyPrefixIndex = 0;
  private httpOnlyDomain = false;
  private fieldIndex = 0;
  private readonly fieldLengths = [0, 0, 0, 0, 0, 0, 0];
  private includeSubdomains = '';
  private secure = '';
  private expiresValid = true;
  private pendingCarriageReturn = false;
  private dataLines = 0;

  push(chunk: Uint8Array): void {
    for (const byte of chunk) {
      if (this.pendingCarriageReturn) {
        if (byte !== 0x0a) throw new CookieFileValidationError('invalid');
        this.pendingCarriageReturn = false;
        this.finishLine();
        continue;
      }
      if (byte === 0x0d) {
        this.pendingCarriageReturn = true;
        continue;
      }
      if (byte === 0x0a) {
        this.finishLine();
        continue;
      }
      this.pushLineByte(byte);
    }
  }

  finish(): void {
    if (this.pendingCarriageReturn) {
      throw new CookieFileValidationError('invalid');
    }
    if (this.lineStarted) this.finishLine();
    if (this.dataLines === 0) throw new CookieFileValidationError('empty');
  }

  private pushLineByte(byte: number): void {
    this.lineStarted = true;
    if (byte !== 0x20 && byte !== 0x09) this.lineIsWhitespace = false;

    if (this.lineKind === 'undecided') {
      if (this.httpOnlyPrefixIndex === 0 && byte !== HTTP_ONLY_PREFIX[0]) {
        this.lineKind = 'data';
        this.pushDataByte(byte);
        return;
      }
      if (byte !== HTTP_ONLY_PREFIX[this.httpOnlyPrefixIndex]) {
        this.lineKind = 'comment';
        return;
      }
      this.httpOnlyPrefixIndex += 1;
      if (this.httpOnlyPrefixIndex === HTTP_ONLY_PREFIX.length) {
        this.lineKind = 'data';
        this.httpOnlyDomain = true;
        this.fieldLengths[0] = HTTP_ONLY_PREFIX.length;
      }
      return;
    }

    if (this.lineKind === 'data') this.pushDataByte(byte);
  }

  private pushDataByte(byte: number): void {
    if (byte === 0x09) {
      this.fieldIndex += 1;
      if (this.fieldIndex > 6) throw new CookieFileValidationError('invalid');
      return;
    }

    this.fieldLengths[this.fieldIndex] =
      this.fieldLengths[this.fieldIndex]! + 1;
    if (this.fieldIndex === 1) {
      if (this.includeSubdomains.length === 5) {
        throw new CookieFileValidationError('invalid');
      }
      this.includeSubdomains += String.fromCharCode(byte);
    } else if (this.fieldIndex === 3) {
      if (this.secure.length === 5) {
        throw new CookieFileValidationError('invalid');
      }
      this.secure += String.fromCharCode(byte);
    } else if (this.fieldIndex === 4 && (byte < 0x30 || byte > 0x39)) {
      this.expiresValid = false;
    }
  }

  private finishLine(): void {
    if (this.lineKind === 'data' && !this.lineIsWhitespace) {
      const domainLength =
        this.fieldLengths[0]! -
        (this.httpOnlyDomain ? HTTP_ONLY_PREFIX.length : 0);
      if (
        this.fieldIndex !== 6 ||
        domainLength === 0 ||
        this.fieldLengths[2] === 0 ||
        this.fieldLengths[4] === 0 ||
        this.fieldLengths[5] === 0 ||
        (this.includeSubdomains !== 'TRUE' &&
          this.includeSubdomains !== 'FALSE') ||
        (this.secure !== 'TRUE' && this.secure !== 'FALSE') ||
        !this.expiresValid
      ) {
        throw new CookieFileValidationError('invalid');
      }
      this.dataLines += 1;
    }
    this.resetLine();
  }

  private resetLine(): void {
    this.lineStarted = false;
    this.lineIsWhitespace = true;
    this.lineKind = 'undecided';
    this.httpOnlyPrefixIndex = 0;
    this.httpOnlyDomain = false;
    this.fieldIndex = 0;
    this.fieldLengths.fill(0);
    this.includeSubdomains = '';
    this.secure = '';
    this.expiresValid = true;
  }
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
    );
    if (bytesWritten === 0) throw new Error('write made no progress');
    offset += bytesWritten;
  }
}

export class CookieAuthorizationService {
  private readonly queueTails = new Map<CookiePlatform, QueueTail>();

  constructor(private readonly storageDirectory: string) {}

  async initialize(): Promise<void> {
    try {
      await mkdir(this.storageDirectory, { recursive: true, mode: 0o700 });
      const directory = await lstat(this.storageDirectory);
      if (!directory.isDirectory()) throw new Error('not a directory');
      await chmod(this.storageDirectory, 0o700);

      for (const definition of COOKIE_PLATFORMS) {
        const finalPath = this.finalPath(definition);
        try {
          const status = await lstat(finalPath);
          if (!status.isFile()) throw new Error('not a regular file');
          await chmod(finalPath, 0o600);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }

        const temporaryPath = this.temporaryPath(definition);
        try {
          const status = await lstat(temporaryPath);
          if (!status.isFile()) throw new Error('not a regular file');
          await unlink(temporaryPath);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
    } catch {
      throw persistenceError();
    }
  }

  async listConfigurations(): Promise<readonly CookieConfiguration[]> {
    try {
      await this.assertStorageDirectory();
      const configurations: CookieConfiguration[] = [];
      for (const definition of COOKIE_PLATFORMS) {
        configurations.push(await this.readConfiguration(definition));
      }
      return configurations;
    } catch {
      throw persistenceError();
    }
  }

  async saveConfiguration(
    platform: string,
    source: Readable,
  ): Promise<CookieConfiguration> {
    const definition = getPlatformDefinition(platform);
    return await this.runExclusive(definition.platform, () =>
      this.save(definition, source),
    );
  }

  async deleteConfiguration(platform: string): Promise<CookieConfiguration> {
    const definition = getPlatformDefinition(platform);
    return await this.runExclusive(definition.platform, () =>
      this.delete(definition),
    );
  }

  private async save(
    definition: PlatformDefinition,
    source: Readable,
  ): Promise<CookieConfiguration> {
    const temporaryPath = this.temporaryPath(definition);
    let handle: FileHandle | undefined;
    let temporaryCreated = false;
    let committed = false;
    let failure: unknown;

    try {
      await this.assertStorageDirectory();
      await this.assertExistingFinalFileIsRegular(definition);
      handle = await open(temporaryPath, 'wx', 0o600);
      temporaryCreated = true;
      await handle.chmod(0o600);

      const validator = new NetscapeCookieValidator();
      for await (const rawChunk of source) {
        if (
          typeof rawChunk !== 'string' &&
          !Buffer.isBuffer(rawChunk) &&
          !(rawChunk instanceof Uint8Array)
        ) {
          throw new Error('non-byte stream chunk');
        }
        const chunk =
          typeof rawChunk === 'string' ? Buffer.from(rawChunk) : rawChunk;
        await writeAll(handle, chunk);
        validator.push(chunk);
      }
      validator.finish();
      await handle.sync();

      const updatedAt = new Date();
      await handle.utimes(updatedAt, updatedAt);
      await handle.close();
      handle = undefined;

      await rename(temporaryPath, this.finalPath(definition));
      committed = true;
      return {
        platform: definition.platform,
        configured: true,
        updatedAt: updatedAt.toISOString(),
      };
    } catch (error) {
      failure = error;
    }

    let cleanupFailed = false;
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        cleanupFailed = true;
      }
    }
    if (temporaryCreated && !committed) {
      try {
        await unlink(temporaryPath);
      } catch (error) {
        if (!isNotFound(error)) cleanupFailed = true;
      }
    }

    if (failure instanceof CookieFileValidationError && !cleanupFailed) {
      throw validationError(
        failure.kind === 'empty' ? EMPTY_FILE_MESSAGE : INVALID_FILE_MESSAGE,
      );
    }
    throw persistenceError();
  }

  private async delete(
    definition: PlatformDefinition,
  ): Promise<CookieConfiguration> {
    try {
      await this.assertStorageDirectory();
      const path = this.finalPath(definition);
      let status;
      try {
        status = await lstat(path);
      } catch (error) {
        if (isNotFound(error)) {
          throw validationError('cookie configuration is not configured');
        }
        throw error;
      }
      if (!status.isFile()) throw new Error('not a regular file');
      await unlink(path);
      return {
        platform: definition.platform,
        configured: false,
        updatedAt: null,
      };
    } catch (error) {
      if (
        error instanceof BusinessError &&
        error.code === 'VALIDATION_ERROR' &&
        error.message === 'cookie configuration is not configured'
      ) {
        throw error;
      }
      throw persistenceError();
    }
  }

  private async readConfiguration(
    definition: PlatformDefinition,
  ): Promise<CookieConfiguration> {
    try {
      const status = await lstat(this.finalPath(definition));
      if (!status.isFile()) throw new Error('not a regular file');
      return {
        platform: definition.platform,
        configured: true,
        updatedAt: status.mtime.toISOString(),
      };
    } catch (error) {
      if (isNotFound(error)) {
        return {
          platform: definition.platform,
          configured: false,
          updatedAt: null,
        };
      }
      throw error;
    }
  }

  private async assertStorageDirectory(): Promise<void> {
    const status = await lstat(this.storageDirectory);
    if (!status.isDirectory()) throw new Error('not a directory');
  }

  private async assertExistingFinalFileIsRegular(
    definition: PlatformDefinition,
  ): Promise<void> {
    try {
      const status = await lstat(this.finalPath(definition));
      if (!status.isFile()) throw new Error('not a regular file');
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  private finalPath(definition: PlatformDefinition): string {
    return join(this.storageDirectory, definition.fileName);
  }

  private temporaryPath(definition: PlatformDefinition): string {
    return join(this.storageDirectory, definition.temporaryFileName);
  }

  private runExclusive<T>(
    platform: CookiePlatform,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.queueTails.get(platform) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.queueTails.set(platform, tail);
    void tail.finally(() => {
      if (this.queueTails.get(platform) === tail) {
        this.queueTails.delete(platform);
      }
    });
    return result;
  }
}
