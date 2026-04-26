import { Router } from 'express';
import {
  livenessHandler,
  readinessHandler,
  deepHealthHandler,
} from './handlers/health.handler.js';

export function buildRouter(): Router {
  const router = Router();

  router.get('/v1/health', livenessHandler);
  router.get('/v1/health/ready', readinessHandler);
  router.get('/v1/health/deep', deepHealthHandler);

  return router;
}
