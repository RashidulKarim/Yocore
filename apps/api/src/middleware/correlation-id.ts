import type { Request, Response, NextFunction } from 'express';
import { newCorrelationId, runWithCorrelationId } from '../lib/correlation-id.js';

declare module 'express' {
  interface Request {
    correlationId?: string;
    requestId?: string;
  }
}

const HEADER = 'x-correlation-id';
const HEADER_REQ = 'x-request-id';

export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.get(HEADER);
  const correlationId = incoming && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(incoming)
    ? incoming
    : newCorrelationId();
  const requestId = newCorrelationId();

  req.correlationId = correlationId;
  req.requestId = requestId;
  res.setHeader(HEADER, correlationId);
  res.setHeader(HEADER_REQ, requestId);

  runWithCorrelationId(correlationId, () => next(), requestId);
}
