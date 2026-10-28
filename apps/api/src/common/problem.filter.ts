import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';

import { isPostgresError, problemFromPostgresError } from './db-errors.js';
import { ProblemError, Problems } from './problem.js';
import type { EstateProRequest } from './request-context.js';

/** Converts every error into an RFC 9457 response (ADR-003 §7). */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProblemFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<EstateProRequest>();
    const res = http.getResponse<Response>();

    const problem = this.toProblem(exception, req);
    if (problem.status >= 500) {
      this.logger.error({ err: exception, requestId: req.requestId }, 'Unhandled error');
    }

    for (const [name, value] of Object.entries(problem.headers)) res.setHeader(name, value);
    res
      .status(problem.status)
      .type('application/problem+json')
      .json(problem.toBody(req.originalUrl.split('?')[0] ?? req.originalUrl, req.requestId));
  }

  private toProblem(exception: unknown, req: EstateProRequest): ProblemError {
    if (exception instanceof ProblemError) return exception;

    if (isPostgresError(exception)) {
      const mapped = problemFromPostgresError(exception);
      if (mapped) return mapped;
      return Problems.internal();
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      switch (status) {
        case 404:
          return Problems.notFound(`No endpoint matches ${req.method} ${req.path}.`);
        case 413:
          return Problems.payloadTooLarge();
        case 415:
          return Problems.unsupportedMediaType();
        case 400:
          return Problems.malformedRequest('The request body is not valid JSON.');
        case 503:
          return new ProblemError(503, 'service-unavailable', 'Service unavailable', 'A dependency is not available. Try again shortly.');
        case 405:
          return new ProblemError(405, 'method-not-allowed', 'Method not allowed');
        default:
          return status >= 500
            ? Problems.internal()
            : new ProblemError(status, 'http-error', exception.message);
      }
    }

    // body-parser errors arrive as plain errors carrying an HTTP status
    if (typeof exception === 'object' && exception !== null && 'type' in exception && 'status' in exception) {
      const { type, status } = exception;
      if (type === 'entity.parse.failed') return Problems.malformedRequest('The request body is not valid JSON.');
      if (type === 'entity.too.large') return Problems.payloadTooLarge();
      if (status === 415) return Problems.unsupportedMediaType();
    }

    return Problems.internal();
  }
}
