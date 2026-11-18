import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';
import { initErrorReporting, ReportingLogger } from './common/error-reporting.js';
import { throttleFlagIgnored } from './common/throttle.js';
import { buildOpenApi, setupApp } from './setup-app.js';
import type { Env } from './config/env.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  initErrorReporting({ SENTRY_DSN: config.get('SENTRY_DSN'), SENTRY_ENVIRONMENT: config.get('SENTRY_ENVIRONMENT'), NODE_ENV: config.get('NODE_ENV') });
  app.useLogger(new ReportingLogger());
  if (throttleFlagIgnored()) {
    new Logger('Bootstrap').warn('THROTTLE_DISABLED=1 is ignored in production: rate limits stay on');
  }
  setupApp(app, config.get('WEB_URL'), {
    trustProxy: config.get('TRUST_PROXY'),
    logFormat: config.get('LOG_FORMAT') ?? (config.get('NODE_ENV') === 'production' ? 'json' : 'pretty'),
    redis: config.get('REDIS_URL') ? { url: config.get('REDIS_URL')!, prefix: config.get('REDIS_PREFIX') } : undefined,
  });

  const document = buildOpenApi(app);
  const swagger = config.get('SWAGGER_ENABLED') ?? (config.get('NODE_ENV') === 'production' ? '0' : '1');
  if (swagger === '1') SwaggerModule.setup('docs', app, document);

  // `npm run generate:openapi` writes the spec consumed by web/ and vscode-extension/.
  if (process.env.OPENAPI_EXPORT) {
    writeFileSync('openapi.json', JSON.stringify(document, null, 2));
    await app.close();
    return;
  }

  await app.listen(config.get('PORT'));
}
await bootstrap();
