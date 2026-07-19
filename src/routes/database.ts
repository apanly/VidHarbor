import { Router } from 'express';

import type { DatabaseConnection } from '../db/client.js';
import { BusinessError } from '../errors.js';

interface DatabaseRow {
  readonly [column: string]: unknown;
}

interface ReadonlyStatement {
  readonly readonly: boolean;
  all(): unknown[];
  columns(): Array<{ name: string }>;
}

export function createDatabaseRouter(database: DatabaseConnection): Router {
  const router = Router();

  router.get('/tables', (_request, response) => {
    const tables = database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .pluck()
      .all() as string[];
    response.json({ tables });
  });

  router.post('/query', (request, response) => {
    const sql = request.body?.sql;
    if (typeof sql !== 'string' || sql === '') {
      throw new BusinessError('VALIDATION_ERROR', 'sql is required');
    }

    try {
      const statement = database.prepare(sql) as unknown as ReadonlyStatement;
      if (!statement.readonly) {
        throw new BusinessError(
          'VALIDATION_ERROR',
          'only readonly SQL is supported',
        );
      }

      const columns = statement.columns().map(({ name }) => name);
      const rows = (statement.all() as DatabaseRow[]).map((row) =>
        columns.map((column) => row[column]),
      );
      response.json({ columns, rows, rowCount: rows.length });
    } catch (error) {
      if (error instanceof BusinessError) throw error;
      throw new BusinessError(
        'VALIDATION_ERROR',
        error instanceof Error ? error.message : 'invalid SQL',
      );
    }
  });

  return router;
}
