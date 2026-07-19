import { Router } from 'express';

import type { DatabaseConnection } from '../db/client.js';
import {
  getSettings,
  updateSettings,
} from '../services/settings.js';

export function createSettingsRouter(
  database: DatabaseConnection,
  downloadsMountPath: string,
): Router {
  const router = Router();

  router.get('/', (_request, response) => {
    response.json(getSettings(database, downloadsMountPath));
  });

  router.put('/', async (request, response) => {
    response.json(
      await updateSettings(database, downloadsMountPath, request.body),
    );
  });

  return router;
}
