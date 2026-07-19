import { Router } from 'express';

import type { DatabaseConnection } from '../db/client.js';
import { BusinessError } from '../errors.js';
import { parsePage, parseQuery } from '../http/pagination.js';
import type { RuntimeCoordinator } from '../runtime.js';
import {
  checkChannel,
  deleteChannel,
  getChannel,
  listChannelChecksPage,
  listChannelsPage,
  listChannelVideosPage,
  pauseChannel,
  resumeChannel,
  acceptInitialChannelSync,
  saveChannel,
  updateChannel,
} from '../services/channel.js';
import type { YtDlpTaskManager } from '../yt-dlp-task-manager.js';

function parseChannelId(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid channel ID');
  }

  const id = Number(value);
  if (!Number.isSafeInteger(id)) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid channel ID');
  }
  return id;
}

export function createChannelsRouter(
  database: DatabaseConnection,
  taskManager: YtDlpTaskManager,
  runtime: RuntimeCoordinator,
): Router {
  const router = Router();
  const initialSyncTaskQueue = {
    trackInitialSync(task: Promise<unknown>): void {
      void task.catch((error: unknown) => {
        if (
          !(error instanceof BusinessError) ||
          error.code === 'PERSISTENCE_ERROR'
        ) {
          runtime.reportError(error);
        }
      });
    },
  };

  router.get('/', (request, response) => {
    response.json(listChannelsPage(database, parsePage(request.query.page)));
  });

  router.post('/', (request, response) => {
    response.status(201).json({ channel: saveChannel(database, request.body) });
  });

  router.post('/:id/initial-sync', (request, response) => {
    response.status(202).json(
      acceptInitialChannelSync(
        database,
        taskManager,
        initialSyncTaskQueue,
        parseChannelId(request.params.id),
        request.body,
      ),
    );
  });

  router.patch('/:id', (request, response) => {
    response.json({
      channel: updateChannel(
        database,
        parseChannelId(request.params.id),
        request.body,
      ),
    });
  });

  router.delete('/:id', (request, response) => {
    deleteChannel(database, parseChannelId(request.params.id));
    response.status(204).end();
  });

  router.post('/:id/pause', (request, response) => {
    if (
      typeof request.body !== 'object' ||
      request.body === null ||
      Array.isArray(request.body) ||
      Object.keys(request.body).length !== 0
    ) {
      throw new BusinessError('VALIDATION_ERROR', 'invalid channel action input');
    }
    response.json({
      channel: pauseChannel(database, parseChannelId(request.params.id)),
    });
  });

  router.post('/:id/resume', (request, response) => {
    if (
      typeof request.body !== 'object' ||
      request.body === null ||
      Array.isArray(request.body) ||
      Object.keys(request.body).length !== 0
    ) {
      throw new BusinessError('VALIDATION_ERROR', 'invalid channel action input');
    }
    response.json({
      channel: resumeChannel(database, parseChannelId(request.params.id)),
    });
  });

  router.post('/:id/check', async (request, response) => {
    if (
      typeof request.body !== 'object' ||
      request.body === null ||
      Array.isArray(request.body) ||
      Object.keys(request.body).length !== 0
    ) {
      throw new BusinessError('VALIDATION_ERROR', 'invalid channel action input');
    }
    response.status(202).json(
      await checkChannel(
        database,
        taskManager,
        parseChannelId(request.params.id),
      ),
    );
  });

  router.get('/:id', (request, response) => {
    response.json({
      channel: getChannel(database, parseChannelId(request.params.id)),
    });
  });

  router.get('/:id/videos', (request, response) => {
    response.json(
      listChannelVideosPage(
        database,
        parseChannelId(request.params.id),
        parsePage(request.query.page),
        parseQuery(request.query.q),
      ),
    );
  });

  router.get('/:id/checks', (request, response) => {
    response.json(
      listChannelChecksPage(
        database,
        parseChannelId(request.params.id),
        parsePage(request.query.page),
      ),
    );
  });

  return router;
}
