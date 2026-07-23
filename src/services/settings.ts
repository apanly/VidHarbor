import type { DatabaseConnection } from '../db/client.js';
import { BusinessError } from '../errors.js';

export interface Settings {
  readonly downloadRoot: string;
  readonly globalCheckIntervalMinutes: number | null;
  readonly downloadConcurrency: number;
}

interface SettingsRow {
  global_check_interval_minutes: number | null;
  download_concurrency: number;
}

interface SettingsInput {
  globalCheckIntervalMinutes: number;
  downloadConcurrency: number;
}

function persistenceError(): BusinessError {
  return new BusinessError('PERSISTENCE_ERROR', 'settings persistence failed');
}

function parseSettingsInput(input: unknown): SettingsInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid settings input');
  }

  const keys = Object.keys(input);
  if (
    keys.length !== 2 ||
    !keys.includes('globalCheckIntervalMinutes') ||
    !keys.includes('downloadConcurrency')
  ) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid settings input');
  }

  const record = input as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record.globalCheckIntervalMinutes) ||
    (record.globalCheckIntervalMinutes as number) < 1 ||
    !Number.isSafeInteger(record.downloadConcurrency) ||
    (record.downloadConcurrency as number) < 1
  ) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid settings input');
  }

  return {
    globalCheckIntervalMinutes: record.globalCheckIntervalMinutes as number,
    downloadConcurrency: record.downloadConcurrency as number,
  };
}

function toSettings(row: SettingsRow, downloadsMountPath: string): Settings {
  return {
    downloadRoot: downloadsMountPath,
    globalCheckIntervalMinutes: row.global_check_interval_minutes,
    downloadConcurrency: row.download_concurrency,
  };
}

export function getSettings(
  database: DatabaseConnection,
  downloadsMountPath: string,
): Settings {
  try {
    const row = database
      .prepare(
        `SELECT global_check_interval_minutes, download_concurrency
         FROM settings
         WHERE id = 1`,
      )
      .get() as SettingsRow | undefined;

    if (row === undefined) {
      throw new Error('settings row is missing');
    }
    return toSettings(row, downloadsMountPath);
  } catch {
    throw persistenceError();
  }
}

export async function updateSettings(
  database: DatabaseConnection,
  downloadsMountPath: string,
  input: unknown,
): Promise<Settings> {
  const settings = parseSettingsInput(input);

  try {
    const result = database
      .prepare(
        `UPDATE settings
         SET global_check_interval_minutes = ?, download_concurrency = ?,
             updated_at = ?
         WHERE id = 1`,
      )
      .run(
        settings.globalCheckIntervalMinutes,
        settings.downloadConcurrency,
        new Date().toISOString(),
      );
    if (result.changes !== 1) {
      throw new Error('settings row is missing');
    }
  } catch {
    throw persistenceError();
  }

  return {
    downloadRoot: downloadsMountPath,
    globalCheckIntervalMinutes: settings.globalCheckIntervalMinutes,
    downloadConcurrency: settings.downloadConcurrency,
  };
}
