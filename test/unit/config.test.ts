import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  it('returns the fixed defaults when the supported variables are absent', () => {
    expect(loadConfig({})).toEqual({
      port: 3000,
      databasePath: '/data/vidharbor.db',
      downloadsMountPath: '/downloads',
    });
  });

  it('reads the three supported environment variables', () => {
    expect(
      loadConfig({
        PORT: '8080',
        DATABASE_PATH: '/var/lib/vidharbor.sqlite',
        DOWNLOADS_MOUNT_PATH: '/mnt/downloads',
      }),
    ).toEqual({
      port: 8080,
      databasePath: '/var/lib/vidharbor.sqlite',
      downloadsMountPath: '/mnt/downloads',
    });
  });

  it('does not read environment variable aliases', () => {
    expect(
      loadConfig({
        SERVER_PORT: '8080',
        DB_PATH: '/tmp/alias.sqlite',
        DOWNLOAD_PATH: '/tmp/alias-downloads',
      }),
    ).toEqual({
      port: 3000,
      databasePath: '/data/vidharbor.db',
      downloadsMountPath: '/downloads',
    });
  });

  it.each(['', '0', '65536', '3000.5', 'not-a-port'])(
    'rejects the invalid PORT value %j',
    (port) => {
      expect(() => loadConfig({ PORT: port })).toThrow(
        'PORT must be an integer between 1 and 65535',
      );
    },
  );
});
