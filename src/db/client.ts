import { createRequire } from 'node:module';

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  all(...parameters: unknown[]): unknown[];
  get(...parameters: unknown[]): unknown;
  pluck(toggleState?: boolean): Statement;
  run(...parameters: unknown[]): RunResult;
}

export interface DatabaseConnection {
  close(): void;
  exec(sql: string): this;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  prepare(sql: string): Statement;
}

type DatabaseConstructor = new (filename: string) => DatabaseConnection;

const require = createRequire(import.meta.url);
const BetterSqlite3 = require('better-sqlite3') as DatabaseConstructor;

export function openDatabase(databasePath: string): DatabaseConnection {
  const database = new BetterSqlite3(databasePath);

  try {
    database.pragma('foreign_keys = ON');
    database.pragma('journal_mode = WAL');
    database.pragma('busy_timeout = 5000');
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
