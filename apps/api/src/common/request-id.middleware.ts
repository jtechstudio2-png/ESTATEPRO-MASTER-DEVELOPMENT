import { randomUUID } from 'node:crypto';

import type { NextFunction, Response } from 'express';

import type { EstateProRequest } from './request-context.js';

const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

/** Accepts a well-formed client X-Request-Id or generates one; echoes it on the response. */
export function requestIdMiddleware(req: EstateProRequest, res: Response, next: NextFunction): void {
  const supplied = req.header('x-request-id');
  const requestId = supplied !== undefined && VALID_REQUEST_ID.test(supplied) ? supplied : randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}
