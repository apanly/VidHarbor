import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/client.js';
import { migrateDatabase } from '../../src/db/migrate.js';

const temporaryDirectories: string[] = [];

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'vidharbor-database-'));
  temporaryDirectories.push(directory);
  return join(directory, 'vidharbor.sqlite');
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('SQLite database', () => {
  it('configures each file connection and migrates an empty database to schema 7', async () => {
    const database = openDatabase(await temporaryDatabasePath());

    try {
      migrateDatabase(database);

      expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(database.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(database.pragma('busy_timeout', { simple: true })).toBe(5000);

      const tables = database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      expect(tables.map(({ name }) => name)).toEqual([
        'channel_checks',
        'channels',
        'downloads',
        'notifications',
        'proxies',
        'schema_migrations',
        'settings',
        'videos',
      ]);

      expect(
        database.prepare('SELECT version FROM schema_migrations ORDER BY version').pluck().all(),
      ).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(
        database
          .prepare(
            `SELECT id, download_root, global_check_interval_minutes,
                    download_concurrency, updated_at
             FROM settings`,
          )
          .get(),
      ).toMatchObject({
        id: 1,
        download_root: null,
        global_check_interval_minutes: 60,
        download_concurrency: 1,
        updated_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      });
      expect(
        database
          .prepare(
            `SELECT sql FROM sqlite_schema
             WHERE type = 'table' AND name = 'channels'`,
          )
          .pluck()
          .get(),
      ).toContain("extractor TEXT NOT NULL DEFAULT 'YoutubeTab'");
      expect(
        database
          .prepare(
            `SELECT sql FROM sqlite_schema
             WHERE type = 'table' AND name = 'channels'`,
          )
          .pluck()
          .get(),
      ).toContain("platform IN ('youtube','bilibili')");
      expect(
        database
          .prepare(
            `SELECT sql FROM sqlite_schema
             WHERE type = 'table' AND name = 'downloads'`,
          )
          .pluck()
          .get(),
      ).toContain('progress_percent REAL');
      expect(
        database
          .prepare(
            `SELECT sql FROM sqlite_schema
             WHERE type = 'table' AND name = 'downloads'`,
          )
          .pluck()
          .get(),
      ).not.toContain("CHECK (platform = 'youtube')");
      expect(
        database
          .prepare(
            `SELECT sql FROM sqlite_schema
             WHERE type = 'table' AND name = 'notifications'`,
          )
          .pluck()
          .get(),
      ).toContain('read_at TEXT');
    } finally {
      database.close();
    }
  });

  it('does not change an already migrated schema 7 database', async () => {
    const database = openDatabase(await temporaryDatabasePath());

    try {
      migrateDatabase(database);
      const appliedAt = database
        .prepare('SELECT applied_at FROM schema_migrations WHERE version = 1')
        .pluck()
        .get();
      const settingsUpdatedAt = database
        .prepare('SELECT updated_at FROM settings WHERE id = 1')
        .pluck()
        .get();

      migrateDatabase(database);

      expect(
        database.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get(),
      ).toBe(7);
      expect(database.prepare('SELECT COUNT(*) FROM settings').pluck().get()).toBe(1);
      expect(
        database
          .prepare('SELECT applied_at FROM schema_migrations WHERE version = 1')
          .pluck()
          .get(),
      ).toBe(appliedAt);
      expect(
        database.prepare('SELECT updated_at FROM settings WHERE id = 1').pluck().get(),
      ).toBe(settingsUpdatedAt);
    } finally {
      database.close();
    }
  });

  it('migrates schema 1 channel data and preserves dependent records', async () => {
    const database = openDatabase(await temporaryDatabasePath());
    const migrationOne = await readFile(
      new URL('../../src/db/migrations/001-initial.sql', import.meta.url),
      'utf8',
    );
    const timestamp = '2026-07-18T10:00:00.000Z';

    try {
      database.exec(migrationOne);
      database.prepare('INSERT INTO schema_migrations VALUES (1, ?)').run(timestamp);
      database
        .prepare(
          `INSERT INTO settings (
            id, download_root, global_check_interval_minutes,
            download_concurrency, updated_at
          ) VALUES (1, NULL, 60, 1, ?)`,
        )
        .run(timestamp);
      const channelId = Number(database
        .prepare(
          `INSERT INTO channels (
            platform, platform_channel_id, source_url, custom_name,
            custom_name_key, initial_synced_at, created_at, updated_at
          ) VALUES ('youtube', 'UC-existing', ?, 'Existing', 'existing', ?, ?, ?)`,
        )
        .run('https://www.youtube.com/@existing', timestamp, timestamp, timestamp)
        .lastInsertRowid);
      const videoId = Number(database
        .prepare(
          `INSERT INTO videos (
            channel_id, platform, platform_video_id, title, published_date,
            source_url, discovery_kind, discovered_at
          ) VALUES (?, 'youtube', 'aB_12-cD345', 'Video', '2026-07-17', ?,
                    'historical', ?)`,
        )
        .run(channelId, 'https://www.youtube.com/watch?v=aB_12-cD345', timestamp)
        .lastInsertRowid);
      database
        .prepare('INSERT INTO notifications (video_id, created_at) VALUES (?, ?)')
        .run(videoId, timestamp);

      migrateDatabase(database);

      expect(
        database
          .prepare(
            `SELECT initial_sync_status, initial_sync_error, initial_synced_at
             FROM channels WHERE id = ?`,
          )
          .get(channelId),
      ).toEqual({
        initial_sync_status: 'succeeded',
        initial_sync_error: null,
        initial_synced_at: timestamp,
      });
      expect(database.prepare('SELECT channel_id FROM videos WHERE id = ?').pluck().get(videoId))
        .toBe(channelId);
      expect(database.prepare('SELECT COUNT(*) FROM notifications').pluck().get()).toBe(1);
      expect(database.pragma('foreign_key_check')).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('migrates schema 2 downloads and preserves Vimeo and unknown direct platform values', async () => {
    const database = openDatabase(await temporaryDatabasePath());
    const migrationOne = await readFile(
      new URL('../../src/db/migrations/001-initial.sql', import.meta.url),
      'utf8',
    );
    const migrationTwo = await readFile(
      new URL('../../src/db/migrations/002-manual-channel-sync.sql', import.meta.url),
      'utf8',
    );
    const timestamp = '2026-07-18T10:00:00.000Z';

    try {
      database.exec(migrationOne);
      database.prepare('INSERT INTO schema_migrations VALUES (1, ?)').run(timestamp);
      database
        .prepare(
          `INSERT INTO settings (
            id, download_root, global_check_interval_minutes,
            download_concurrency, updated_at
          ) VALUES (1, NULL, 60, 1, ?)`,
        )
        .run(timestamp);
      database.exec(migrationTwo);
      database.prepare('INSERT INTO schema_migrations VALUES (2, ?)').run(timestamp);
      database
        .prepare(
          `INSERT INTO downloads (
            source_type, source_url, platform, platform_video_id, title,
            network_mode, status, created_at
          ) VALUES ('direct', ?, 'youtube', 'aB_12-cD345', 'Existing',
                    'direct', 'pending', ?)`,
        )
        .run('https://youtu.be/aB_12-cD345', timestamp);

      migrateDatabase(database);

      expect(database.prepare('SELECT version FROM schema_migrations ORDER BY version').pluck().all())
        .toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(database.prepare('SELECT platform_video_id FROM downloads').pluck().all())
        .toEqual(['aB_12-cD345']);
      expect(database.prepare(
        'SELECT duration_seconds, thumbnail_path, archive_layout, output_size_bytes FROM downloads',
      ).get()).toEqual({
        duration_seconds: null,
        thumbnail_path: null,
        archive_layout: 'legacy_file',
        output_size_bytes: null,
      });
      expect(() =>
        database
          .prepare(
            `INSERT INTO downloads (
              source_type, source_url, platform, platform_video_id, title,
              network_mode, status, created_at
            ) VALUES ('direct', 'https://media.example/videos/unknown-platform', 'unknown-platform',
                      'unknown-platform', 'Unknown Platform', 'direct', 'pending', ?)`,
          )
          .run(timestamp),
      ).not.toThrow();
      expect(() =>
        database
          .prepare(
            `INSERT INTO downloads (
              source_type, source_url, platform, platform_video_id, title,
              network_mode, status, created_at
            ) VALUES ('direct', 'https://vimeo.com/123456789', 'vimeo',
                      '123456789', 'Historical Vimeo', 'direct', 'pending', ?)`,
          )
          .run(timestamp),
      ).not.toThrow();
      expect(database.prepare(
        `SELECT platform, title FROM downloads
         WHERE platform IN ('vimeo', 'unknown-platform') ORDER BY id`,
      ).all()).toEqual([
        { platform: 'unknown-platform', title: 'Unknown Platform' },
        { platform: 'vimeo', title: 'Historical Vimeo' },
      ]);
      expect(database.pragma('foreign_key_check')).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('enforces CHECK, UNIQUE, and FOREIGN KEY constraints', async () => {
    const database = openDatabase(await temporaryDatabasePath());

    try {
      migrateDatabase(database);

      expect(() =>
        database
          .prepare(
            "INSERT INTO proxies (name, proxy_url, created_at, updated_at) VALUES ('proxy', 'http://localhost:8080', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z')",
          )
          .run(),
      ).not.toThrow();
      expect(() =>
        database
          .prepare(
            "INSERT INTO proxies (name, proxy_url, created_at, updated_at) VALUES ('proxy', 'http://localhost:8081', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z')",
          )
          .run(),
      ).toThrow(/UNIQUE constraint failed/);
      expect(() =>
        database
          .prepare(
            "INSERT INTO videos (channel_id, platform, platform_video_id, title, published_date, source_url, discovery_kind, discovered_at) VALUES (999, 'youtube', 'video', 'Title', '2026-07-17', 'https://www.youtube.com/watch?v=video', 'historical', '2026-07-17T00:00:00.000Z')",
          )
          .run(),
      ).toThrow(/FOREIGN KEY constraint failed/);
      expect(() =>
        database
          .prepare(
            "INSERT INTO downloads (source_type, source_url, platform, platform_video_id, title, network_mode, status, created_at) VALUES ('unknown', 'https://www.youtube.com/watch?v=video', 'youtube', 'video', 'Title', 'direct', 'pending', '2026-07-17T00:00:00.000Z')",
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        database
          .prepare(
            "INSERT INTO downloads (source_type, source_url, platform, platform_video_id, title, network_mode, status, created_at) VALUES ('direct', 'https://www.youtube.com/watch?v=video', 'youtube', 'video', 'Title', 'direct', 'unknown', '2026-07-17T00:00:00.000Z')",
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        database
          .prepare(
            "INSERT INTO downloads (source_type, source_url, platform, platform_video_id, title, network_mode, status, output_size_bytes, created_at) VALUES ('direct', 'https://www.youtube.com/watch?v=video', 'youtube', 'video', 'Title', 'direct', 'pending', 1, '2026-07-17T00:00:00.000Z')",
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      database.close();
    }
  });

  it('rejects an unknown migration version', async () => {
    const database = openDatabase(await temporaryDatabasePath());

    try {
      migrateDatabase(database);
      database.prepare('UPDATE schema_migrations SET version = 8 WHERE version = 7').run();

      expect(() => migrateDatabase(database)).toThrow('Unknown schema migration version: 1, 2, 3, 4, 5, 6, 8');
    } finally {
      database.close();
    }
  });

  it('rejects a schema whose constraints or indexes do not match the latest schema', async () => {
    const database = openDatabase(await temporaryDatabasePath());

    try {
      migrateDatabase(database);
      database.exec('DROP INDEX idx_downloads_created');

      expect(() => migrateDatabase(database)).toThrow(
        'Database schema does not match latest migration version',
      );
    } finally {
      database.close();
    }
  });

  it('rejects a damaged database file without rebuilding it', async () => {
    const databasePath = await temporaryDatabasePath();
    await writeFile(databasePath, 'not a sqlite database', 'utf8');

    expect(() => openDatabase(databasePath)).toThrow();
    await expect(writeFile(databasePath, 'not a sqlite database', { flag: 'wx' })).rejects.toThrow();
  });
});
