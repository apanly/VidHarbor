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
import { requireSameOrigin } from './http/same-origin.js';
import { createChannelsRouter } from './routes/channels.js';
import { createAuthorizationsRouter } from './routes/authorizations.js';
import { createDatabaseRouter } from './routes/database.js';
import { createDownloadsRouter } from './routes/downloads.js';
import { createNotificationsRouter } from './routes/notifications.js';
import { createPagesRouter } from './routes/pages.js';
import { createProxiesRouter } from './routes/proxies.js';
import { createSettingsRouter } from './routes/settings.js';
import { createYtDlpTasksRouter } from './routes/yt-dlp-tasks.js';
import type { DownloadQueue } from './services/download.js';
import type { CookieAuthorizationService } from './services/cookie-authorization.js';
import type { RuntimeCoordinator } from './runtime.js';
import type { YtDlpTaskManager } from './yt-dlp-task-manager.js';

const requireJsonBody: RequestHandler = (request, _response, next) => {
  if (!['POST', 'PUT', 'PATCH'].includes(request.method)) {
    next();
    return;
  }

  const isCookieUpload =
    ['POST', 'PUT'].includes(request.method) &&
    /^\/authorizations\/cookies\/[^/]+$/.test(request.path);
  const requiredMediaType = isCookieUpload
    ? 'application/octet-stream'
    : 'application/json';

  if (request.is(requiredMediaType) !== requiredMediaType) {
    next(
      new BusinessError(
        'VALIDATION_ERROR',
        `${requiredMediaType} required`,
      ),
    );
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
  taskManager: YtDlpTaskManager,
  downloadQueue: DownloadQueue,
  cookieAuthorizationService: CookieAuthorizationService,
): Router {
  const router = express.Router();

  router.use(
    '/authorizations',
    createAuthorizationsRouter(database, cookieAuthorizationService),
  );
  router.use('/settings', createSettingsRouter(database, downloadsMountPath));
  router.use('/database', createDatabaseRouter(database));
  router.use('/proxies', createProxiesRouter(database));
  router.use(
    '/channels',
    createChannelsRouter(
      database,
      taskManager,
      runtime,
      cookieAuthorizationService,
    ),
  );
  router.use('/notifications', createNotificationsRouter(database));
  router.use('/yt-dlp/tasks', createYtDlpTasksRouter(taskManager));
  router.use(
    '/downloads',
    createDownloadsRouter(
      database,
      downloadsMountPath,
      taskManager,
      downloadQueue,
      runtime,
    ),
  );

  return router;
}
