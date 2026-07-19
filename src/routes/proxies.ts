import { Router } from 'express';

import type { DatabaseConnection } from '../db/client.js';
import { BusinessError } from '../errors.js';
import {
  createProxy,
  deleteProxy,
  listProxies,
  updateProxy,
} from '../services/proxy.js';

function parseProxyId(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid proxy ID');
  }

  const id = Number(value);
  if (!Number.isSafeInteger(id)) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid proxy ID');
  }

  return id;
}

export function createProxiesRouter(database: DatabaseConnection): Router {
  const router = Router();

  router.get('/', (_request, response) => {
    response.json({ items: listProxies(database) });
  });

  router.post('/', (request, response) => {
    response.status(201).json(createProxy(database, request.body));
  });

  router.patch('/:id', (request, response) => {
    response.json(
      updateProxy(database, parseProxyId(request.params.id), request.body),
    );
  });

  router.delete('/:id', (request, response) => {
    deleteProxy(database, parseProxyId(request.params.id));
    response.status(204).end();
  });

  return router;
}
