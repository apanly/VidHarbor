import { Router } from 'express';

import type { DatabaseConnection } from '../db/client.js';
import { BusinessError } from '../errors.js';
import {
  type CookieAuthorizationService,
  type CookieConfiguration,
} from '../services/cookie-authorization.js';

function toConfigurationResponse(configuration: CookieConfiguration): {
  readonly platform: CookieConfiguration['platform'];
  readonly configured: boolean;
  readonly updatedAt: string | null;
} {
  return {
    platform: configuration.platform,
    configured: configuration.configured,
    updatedAt: configuration.updatedAt,
  };
}

export function createAuthorizationsRouter(
  database: DatabaseConnection,
  cookieAuthorizationService: CookieAuthorizationService,
): Router {
  const router = Router();

  router.get('/cookies', async (_request, response) => {
    const configurations =
      await cookieAuthorizationService.listConfigurations();
    response.json({
      configurations: configurations
        .filter(({ configured }) => configured)
        .map(toConfigurationResponse),
    });
  });

  router.post('/cookies/:platform', async (request, response) => {
    const configuration = await cookieAuthorizationService.createConfiguration(
      request.params.platform,
      request,
    );
    response.json({
      configuration: toConfigurationResponse(configuration),
    });
  });

  router.put('/cookies/:platform', async (request, response) => {
    const configuration = await cookieAuthorizationService.updateConfiguration(
      request.params.platform,
      request,
    );
    response.json({
      configuration: toConfigurationResponse(configuration),
    });
  });

  router.post('/cookies/bilibili/validate', async (_request, response) => {
    response.json({
      valid: await cookieAuthorizationService.validateBilibiliConfiguration(),
    });
  });

  router.delete('/cookies/:platform', async (request, response) => {
    const referenceCount = database
      .prepare(
        'SELECT COUNT(*) FROM channels WHERE authorization_platform = ?',
      )
      .pluck()
      .get(request.params.platform) as number;
    if (referenceCount > 0) {
      throw new BusinessError(
        'AUTHORIZATION_IN_USE',
        'cookie authorization is used by channels',
      );
    }
    const configuration =
      await cookieAuthorizationService.deleteConfiguration(
        request.params.platform,
      );
    response.json({
      configuration: toConfigurationResponse(configuration),
    });
  });

  return router;
}
