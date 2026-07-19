import express, {
  type ErrorRequestHandler,
  type RequestHandler,
  type Router,
} from 'express';
import { fileURLToPath } from 'node:url';

import {
  BusinessError,
  getHttpStatus,
  toErrorResponse,
} from './errors.js';
import type { DatabaseConnection } from './db/client.js';
import { DownloadWorker } from './download-worker.js';
import { requireSameOrigin } from './http/same-origin.js';
import { createChannelsRouter } from './routes/channels.js';
import { createDownloadsRouter } from './routes/downloads.js';
import { createNotificationsRouter } from './routes/notifications.js';
import { createPagesRouter } from './routes/pages.js';
import { createProxiesRouter } from './routes/proxies.js';
import { createSettingsRouter } from './routes/settings.js';
import type { DownloadQueue } from './services/download.js';
import type { RuntimeCoordinator } from './runtime.js';

const requireJsonBody: RequestHandler = (request, _response, next) => {
  if (
    ['POST', 'PUT', 'PATCH'].includes(request.method) &&
    request.is('application/json') !== 'application/json'
  ) {
    next(new BusinessError('VALIDATION_ERROR', 'application/json required'));
    return;
  }

  next();
};

function isJsonParseError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    error.status === 400 &&
    'type' in error &&
    error.type === 'entity.parse.failed'
  );
}

const apiErrorHandler: ErrorRequestHandler = (
  error: unknown,
  _request,
  response,
  _next,
) => {
  if (error instanceof BusinessError) {
    response.status(getHttpStatus(error.code)).json(toErrorResponse(error));
    return;
  }

  if (isJsonParseError(error)) {
    const validationError = new BusinessError(
      'VALIDATION_ERROR',
      'invalid request body',
    );
    response
      .status(getHttpStatus(validationError.code))
      .json(toErrorResponse(validationError));
    return;
  }

  const internalError = new BusinessError(
    'PERSISTENCE_ERROR',
    'internal server error',
  );
  response
    .status(getHttpStatus(internalError.code))
    .json(toErrorResponse(internalError));
};

export function createApp(apiRouter: Router): express.Express {
  const app = express();

  app.set('views', fileURLToPath(new URL('./views', import.meta.url)));
  app.set('view engine', 'ejs');

  app.use('/api', (_request, response, next) => {
    response.type('application/json');
    next();
  });
  app.use('/api', requireSameOrigin, requireJsonBody, express.json());
  app.use('/api', apiRouter);
  app.use('/api', apiErrorHandler);
  app.use(createPagesRouter());

  return app;
}

export function createApiRouter(
  database: DatabaseConnection,
  downloadsMountPath: string,
  runtime: RuntimeCoordinator,
  ytDlpExecutablePath = 'yt-dlp',
  downloadQueue: DownloadQueue = new DownloadWorker(
    database,
    ytDlpExecutablePath,
  ),
): Router {
  const router = express.Router();

  router.use('/settings', createSettingsRouter(database, downloadsMountPath));
  router.use('/proxies', createProxiesRouter(database));
  router.use('/channels', createChannelsRouter(database, ytDlpExecutablePath, runtime));
  router.use('/notifications', createNotificationsRouter(database));
  router.use(
    '/downloads',
    createDownloadsRouter(
      database,
      downloadsMountPath,
      ytDlpExecutablePath,
      downloadQueue,
      runtime,
    ),
  );

  return router;
}
