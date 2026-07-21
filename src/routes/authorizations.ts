import { Router } from 'express';

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
  cookieAuthorizationService: CookieAuthorizationService,
): Router {
  const router = Router();

  router.get('/cookies', async (_request, response) => {
    const configurations =
      await cookieAuthorizationService.listConfigurations();
    response.json({
      configurations: configurations.map(toConfigurationResponse),
    });
  });

  router.put('/cookies/:platform', async (request, response) => {
    const configuration = await cookieAuthorizationService.saveConfiguration(
      request.params.platform,
      request,
    );
    response.json({
      configuration: toConfigurationResponse(configuration),
    });
  });

  router.delete('/cookies/:platform', async (request, response) => {
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
