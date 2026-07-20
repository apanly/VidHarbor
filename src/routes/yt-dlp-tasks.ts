import express, { type Router } from 'express';

import type { YtDlpTaskManager } from '../yt-dlp-task-manager.js';

export function createYtDlpTasksRouter(
  taskManager: YtDlpTaskManager,
): Router {
  const router = express.Router();

  router.get('/', (_request, response) => {
    response.json({ tasks: taskManager.getSnapshot() });
  });

  return router;
}
