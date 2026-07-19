import { Router } from 'express';

import type { DatabaseConnection } from '../db/client.js';
import { BusinessError } from '../errors.js';
import {
  checkChannel,
  deleteChannel,
  listChannelChecks,
  listChannels,
  listChannelVideos,
  pauseChannel,
  resumeChannel,
  acceptInitialChannelSync,
  saveChannel,
  updateChannel,
  type InitialSyncTaskQueue,
} from '../services/channel.js';

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
  ytDlpExecutablePath: string,
  initialSyncTaskQueue: InitialSyncTaskQueue,
): Router {
  const router = Router();

  router.get('/', (_request, response) => {
    response.json({ items: listChannels(database) });
  });

  router.post('/', (request, response) => {
    response.status(201).json({ channel: saveChannel(database, request.body) });
  });

  router.post('/:id/initial-sync', (request, response) => {
    response.status(202).json(
      acceptInitialChannelSync(
        database,
        ytDlpExecutablePath,
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
        ytDlpExecutablePath,
        parseChannelId(request.params.id),
      ),
    );
  });

  router.get('/:id/videos', (request, response) => {
    response.json({
      items: listChannelVideos(
        database,
        parseChannelId(request.params.id),
      ),
    });
  });

  router.get('/:id/checks', (request, response) => {
    response.json({
      items: listChannelChecks(
        database,
        parseChannelId(request.params.id),
      ),
    });
  });

  return router;
}
