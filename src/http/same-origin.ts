import type { RequestHandler } from 'express';

import { BusinessError } from '../errors.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const requireSameOrigin: RequestHandler = (request, _response, next) => {
  if (!WRITE_METHODS.has(request.method)) {
    next();
    return;
  }

  const host = request.get('host');
  const origin = request.get('origin');
  if (
    host === undefined ||
    origin === undefined ||
    origin !== `${request.protocol}://${host}`
  ) {
    next(new BusinessError('VALIDATION_ERROR', 'invalid request origin'));
    return;
  }

  next();
};
