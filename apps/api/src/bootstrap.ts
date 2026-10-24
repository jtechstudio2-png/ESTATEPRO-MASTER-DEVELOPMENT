import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';

import { requestIdMiddleware } from './common/request-id.middleware.js';
import { createValidationPipe } from './common/validation.js';

export const API_VERSION = '0.1.0';

/** Applies the HTTP behaviour shared by the server, the tests and the OpenAPI generator. */
export function configureApp(app: NestExpressApplication, options: { trustProxyHops: number }): void {
  app.useLogger(app.get(Logger));
  app.set('query parser', 'extended'); // filter[status]=…, filter[price][gte]=… (ADR-003 §6)
  app.set('trust proxy', options.trustProxyHops);
  app.disable('x-powered-by');
  app.set('etag', false); // ETag is the record version, set explicitly by handlers (ADR-003 §4)
  app.use(requestIdMiddleware);
  app.useBodyParser('json', { limit: '1mb' });
  app.useGlobalPipes(createValidationPipe());
  app.enableShutdownHooks();
}

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setOpenAPIVersion('3.1.0')
    .setTitle('EstatePro API')
    .setDescription(
      'Multi-tenant real estate and property management API. Conventions: docs/decisions/ADR-003-api-conventions.md',
    )
    .setVersion(API_VERSION)
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .build();
  return SwaggerModule.createDocument(app, config, { operationIdFactory: (controller, method) => `${controller.replace(/Controller$/, '')}_${method}` });
}
