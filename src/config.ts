export interface AppConfig {
  readonly port: number;
  readonly databasePath: string;
  readonly downloadsMountPath: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

const DEFAULT_PORT = 3000;
const DEFAULT_DATABASE_PATH = '/data/vidharbor.db';
const DEFAULT_DOWNLOADS_MOUNT_PATH = '/downloads';

function parsePort(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_PORT;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  return port;
}

export function loadConfig(environment: Environment = process.env): AppConfig {
  return {
    port: parsePort(environment.PORT),
    databasePath: environment.DATABASE_PATH ?? DEFAULT_DATABASE_PATH,
    downloadsMountPath:
      environment.DOWNLOADS_MOUNT_PATH ?? DEFAULT_DOWNLOADS_MOUNT_PATH,
  };
}
