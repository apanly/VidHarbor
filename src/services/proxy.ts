import type { DatabaseConnection } from '../db/client.js';
import { BusinessError } from '../errors.js';
export interface ProxyConfig {
  readonly id: number;
  readonly name: string;
  readonly protocol: 'http' | 'https' | 'socks5';
  readonly host: string;
  readonly port: number;
  readonly username: string | null;
  readonly maskedPassword: string | null;
}

interface ProxyInput {
  readonly name: string;
  readonly protocol: 'http' | 'https' | 'socks5';
  readonly host: string;
  readonly port: number;
  readonly username: string | null;
  readonly password: string | null;
}

interface ProxyRow {
  id: number;
  name: string;
  proxy_url: string;
}

const PROXY_PROTOCOLS = new Set(['http', 'https', 'socks5']);
const HOST_FORBIDDEN_PATTERN = /[\s:/\\?#@]/u;

function persistenceError(): BusinessError {
  return new BusinessError('PERSISTENCE_ERROR', 'proxy persistence failed');
}

function validateProxyId(id: number): void {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid proxy ID');
  }
}

function parseProxyInput(input: unknown): ProxyInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid proxy input');
  }

  const keys = Object.keys(input);
  if (
    keys.length !== 6 ||
    !keys.includes('name') ||
    !keys.includes('protocol') ||
    !keys.includes('host') ||
    !keys.includes('port') ||
    !keys.includes('username') ||
    !keys.includes('password')
  ) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid proxy input');
  }

  const record = input as Record<string, unknown>;
  const username = record.username;
  const password = record.password;
  if (
    typeof record.name !== 'string' ||
    record.name.trim() !== record.name ||
    Array.from(record.name).length < 1 ||
    Array.from(record.name).length > 80 ||
    typeof record.protocol !== 'string' ||
    !PROXY_PROTOCOLS.has(record.protocol) ||
    typeof record.host !== 'string' ||
    record.host.trim() !== record.host ||
    record.host === '' ||
    HOST_FORBIDDEN_PATTERN.test(record.host) ||
    !Number.isSafeInteger(record.port) ||
    (record.port as number) < 1 ||
    (record.port as number) > 65535 ||
    !(
      (username === null && password === null) ||
      (typeof username === 'string' &&
        username !== '' &&
        typeof password === 'string' &&
        password !== '')
    )
  ) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid proxy input');
  }

  const proxy = {
    name: record.name,
    protocol: record.protocol as ProxyInput['protocol'],
    host: record.host,
    port: record.port as number,
    username,
    password,
  };
  try {
    const parsed = new URL(toProxyUrl(proxy));
    if (parsed.hostname === '' || parsed.port !== String(proxy.port)) {
      throw new Error('invalid proxy endpoint');
    }
  } catch {
    throw new BusinessError('VALIDATION_ERROR', 'invalid proxy input');
  }
  return proxy;
}

function maskPassword(password: string | null): string | null {
  if (password === null) return null;
  const visiblePrefix = Array.from(password).slice(0, 2).join('');
  return `${visiblePrefix}${'*'.repeat(Math.max(4, Array.from(password).length - 2))}`;
}

function toProxyUrl(input: ProxyInput): string {
  const credentials =
    input.username === null
      ? ''
      : `${encodeURIComponent(input.username)}:${encodeURIComponent(input.password as string)}@`;
  return `${input.protocol}://${credentials}${input.host}:${String(input.port)}`;
}

function toProxy(row: ProxyRow): ProxyConfig {
  const parsed = new URL(row.proxy_url);
  const protocol = parsed.protocol.slice(0, -1);
  if (
    !PROXY_PROTOCOLS.has(protocol) ||
    parsed.hostname === '' ||
    parsed.port === ''
  ) {
    throw persistenceError();
  }

  return {
    id: row.id,
    name: row.name,
    protocol: protocol as ProxyConfig['protocol'],
    host: parsed.hostname,
    port: Number(parsed.port),
    username:
      parsed.username === '' ? null : decodeURIComponent(parsed.username),
    maskedPassword:
      parsed.password === '' ? null : maskPassword(decodeURIComponent(parsed.password)),
  };
}

export function listProxies(database: DatabaseConnection): ProxyConfig[] {
  try {
    const rows = database
      .prepare('SELECT id, name, proxy_url FROM proxies ORDER BY id')
      .all() as ProxyRow[];
    return rows.map(toProxy);
  } catch {
    throw persistenceError();
  }
}

export function createProxy(
  database: DatabaseConnection,
  input: unknown,
): ProxyConfig {
  const proxy = parseProxyInput(input);
  const proxyUrl = toProxyUrl(proxy);

  try {
    const conflictingId = database
      .prepare('SELECT id FROM proxies WHERE name = ?')
      .pluck()
      .get(proxy.name);
    if (conflictingId !== undefined) {
      throw new BusinessError('PROXY_NAME_EXISTS', 'proxy name already exists');
    }

    const now = new Date().toISOString();
    const result = database
      .prepare(
        `INSERT INTO proxies (name, proxy_url, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(proxy.name, proxyUrl, now, now);
    return {
      id: Number(result.lastInsertRowid),
      name: proxy.name,
      protocol: proxy.protocol,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username,
      maskedPassword: maskPassword(proxy.password),
    };
  } catch (error) {
    if (error instanceof BusinessError) {
      throw error;
    }
    throw persistenceError();
  }
}

export function updateProxy(
  database: DatabaseConnection,
  id: number,
  input: unknown,
): ProxyConfig {
  validateProxyId(id);
  const proxy = parseProxyInput(input);
  const proxyUrl = toProxyUrl(proxy);

  try {
    const existingId = database
      .prepare('SELECT id FROM proxies WHERE id = ?')
      .pluck()
      .get(id);
    if (existingId === undefined) {
      throw new BusinessError('PROXY_NOT_FOUND', 'proxy not found');
    }

    const conflictingId = database
      .prepare('SELECT id FROM proxies WHERE name = ? AND id <> ?')
      .pluck()
      .get(proxy.name, id);
    if (conflictingId !== undefined) {
      throw new BusinessError('PROXY_NAME_EXISTS', 'proxy name already exists');
    }

    database
      .prepare(
        `UPDATE proxies
         SET name = ?, proxy_url = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(proxy.name, proxyUrl, new Date().toISOString(), id);
    return {
      id,
      name: proxy.name,
      protocol: proxy.protocol,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username,
      maskedPassword: maskPassword(proxy.password),
    };
  } catch (error) {
    if (error instanceof BusinessError) {
      throw error;
    }
    throw persistenceError();
  }
}

export function deleteProxy(database: DatabaseConnection, id: number): void {
  validateProxyId(id);

  try {
    const existingId = database
      .prepare('SELECT id FROM proxies WHERE id = ?')
      .pluck()
      .get(id);
    if (existingId === undefined) {
      throw new BusinessError('PROXY_NOT_FOUND', 'proxy not found');
    }

    const reference = database
      .prepare('SELECT id FROM channels WHERE proxy_id = ? LIMIT 1')
      .pluck()
      .get(id);
    if (reference !== undefined) {
      throw new BusinessError('PROXY_IN_USE', 'proxy is in use');
    }

    database.prepare('DELETE FROM proxies WHERE id = ?').run(id);
  } catch (error) {
    if (error instanceof BusinessError) {
      throw error;
    }
    throw persistenceError();
  }
}
