import { readFileSync } from 'node:fs';

import { openDatabase, type DatabaseConnection } from './client.js';

interface SchemaEntry {
  name: string;
  sql: string;
  type: string;
}

const MIGRATIONS = [
  readFileSync(new URL('./migrations/001-initial.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('./migrations/002-manual-channel-sync.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('./migrations/003-generic-direct-downloads.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('./migrations/004-download-artifacts.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('./migrations/005-download-size.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('./migrations/006-bilibili-channels.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('./migrations/007-channel-cookie-authorization.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('./migrations/008-download-deleting-status.sql', import.meta.url), 'utf8'),
] as const;

function schemaEntries(database: DatabaseConnection): SchemaEntry[] {
  return database
    .prepare(
      `SELECT type, name, sql
       FROM sqlite_schema
       WHERE type IN ('table', 'index')
         AND name NOT LIKE 'sqlite_%'
         AND sql IS NOT NULL
       ORDER BY type, name`,
    )
    .all() as SchemaEntry[];
}

function expectedSchemaEntries(): SchemaEntry[] {
  const referenceDatabase = openDatabase(':memory:');

  try {
    for (const migration of MIGRATIONS) referenceDatabase.exec(migration);
    return schemaEntries(referenceDatabase);
  } finally {
    referenceDatabase.close();
  }
}

function assertSchemaMatchesLatestVersion(database: DatabaseConnection): void {
  if (JSON.stringify(schemaEntries(database)) !== JSON.stringify(expectedSchemaEntries())) {
    throw new Error('Database schema does not match latest migration version');
  }

  const settingsRows = database.prepare('SELECT id FROM settings').all() as Array<{
    id: number;
  }>;
  if (settingsRows.length !== 1 || settingsRows[0]?.id !== 1) {
    throw new Error('Database schema does not contain the required settings row');
  }
}

function assertDatabaseIntegrity(database: DatabaseConnection): void {
  if (database.pragma('integrity_check', { simple: true }) !== 'ok') {
    throw new Error('Database integrity check failed');
  }

  if ((database.pragma('foreign_key_check') as unknown[]).length !== 0) {
    throw new Error('Database foreign key check failed');
  }
}

export function migrateDatabase(database: DatabaseConnection): void {
  database.pragma('foreign_keys = OFF');
  database.exec('BEGIN EXCLUSIVE');

  try {
    assertDatabaseIntegrity(database);

    const schemaMigrationTableExists =
      database
        .prepare(
          "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'",
        )
        .pluck()
        .get() === 1;

    if (!schemaMigrationTableExists) {
      const existingSchemaEntryCount = database
        .prepare(
          "SELECT COUNT(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL",
        )
        .pluck()
        .get();
      if (existingSchemaEntryCount !== 0) {
        throw new Error('Database schema does not contain schema_migrations');
      }

      database.exec(MIGRATIONS[0]);
      const appliedAt = new Date().toISOString();
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)')
        .run(appliedAt);
      database
        .prepare(
          `INSERT INTO settings (
            id, global_check_interval_minutes, download_concurrency, updated_at
          ) VALUES (1, 60, 1, ?)`,
        )
        .run(appliedAt);
      database.exec(MIGRATIONS[1]);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)')
        .run(appliedAt);
      database.exec(MIGRATIONS[2]);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (3, ?)')
        .run(appliedAt);
      database.exec(MIGRATIONS[3]);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (4, ?)')
        .run(appliedAt);
      database.exec(MIGRATIONS[4]);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (5, ?)')
        .run(appliedAt);
      database.exec(MIGRATIONS[5]);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (6, ?)')
        .run(appliedAt);
      database.exec(MIGRATIONS[6]);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (7, ?)')
        .run(appliedAt);
      database.exec(MIGRATIONS[7]);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (8, ?)')
        .run(appliedAt);
    } else {
      const versions = database
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .pluck()
        .all() as number[];
      if (
        versions.length === 0 ||
        versions.length > MIGRATIONS.length ||
        versions.some((version, index) => version !== index + 1)
      ) {
        throw new Error(`Unknown schema migration version: ${versions.join(', ')}`);
      }
      const appliedAt = new Date().toISOString();
      for (let index = versions.length; index < MIGRATIONS.length; index += 1) {
        database.exec(MIGRATIONS[index] as string);
        database
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(index + 1, appliedAt);
      }
    }

    assertSchemaMatchesLatestVersion(database);
    assertDatabaseIntegrity(database);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    database.pragma('foreign_keys = ON');
  }
}
