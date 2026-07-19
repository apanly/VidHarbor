import { Router } from 'express';

import type { DatabaseConnection } from '../db/client.js';
import { BusinessError } from '../errors.js';
import { parsePage } from '../http/pagination.js';
import {
  listNotificationsPage,
  markAllNotificationsRead,
  markNotificationsRead,
} from '../services/notification.js';

function parseNotificationId(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid notification ID');
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id)) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid notification ID');
  }
  return id;
}

function parseReadAllInput(input: unknown): readonly number[] {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid notification input');
  }
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== 'ids') {
    throw new BusinessError('VALIDATION_ERROR', 'invalid notification input');
  }
  const ids = (input as Record<string, unknown>).ids;
  if (!Array.isArray(ids)) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid notification input');
  }
  return ids as unknown as readonly number[];
}

export function createNotificationsRouter(
  database: DatabaseConnection,
): Router {
  const router = Router();

  router.get('/', (request, response) => {
    response.json(
      listNotificationsPage(database, parsePage(request.query.page)),
    );
  });

  router.post('/read-all', (request, response) => {
    if (
      typeof request.body !== 'object' ||
      request.body === null ||
      Array.isArray(request.body) ||
      Object.keys(request.body).length !== 0
    ) {
      throw new BusinessError('VALIDATION_ERROR', 'invalid notification input');
    }
    response.json({ changed: markAllNotificationsRead(database) });
  });

  router.post('/:id/read', (request, response) => {
    if (
      typeof request.body !== 'object' ||
      request.body === null ||
      Array.isArray(request.body) ||
      Object.keys(request.body).length !== 0
    ) {
      throw new BusinessError('VALIDATION_ERROR', 'invalid notification input');
    }
    response.json({
      changed: markNotificationsRead(database, [
        parseNotificationId(request.params.id),
      ]),
    });
  });

  router.post('/read', (request, response) => {
    response.json({
      changed: markNotificationsRead(database, parseReadAllInput(request.body)),
    });
  });

  return router;
}
