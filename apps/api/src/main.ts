import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const logger = new Logger('bootstrap');

  app.setGlobalPrefix('api/v1', {
    // Probes and the Prometheus scrape must not be versioned — an orchestrator
    // should never need to know which API version is deployed to health-check it.
    exclude: ['health', 'ready', 'metrics'],
  });

  app.use(cookieParser());

  app.enableCors({
    origin: (process.env['CORS_ORIGIN'] ?? 'http://localhost:5173').split(','),
    // Required for the refresh cookie to be sent cross-origin.
    credentials: true,
    exposedHeaders: ['X-Request-Id', 'X-Idempotent-Replay'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip unknown properties rather than trusting them: a client sending
      // `{"priority": 5, "status": "COMPLETED"}` must not be able to set status.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('Distributed Job Scheduler API')
    .setDescription(
      'Reliable background job execution across multiple workers.\n\n' +
        '**Auth** — send `Authorization: Bearer <jwt>` (dashboard) or `X-API-Key` (services).\n\n' +
        '**Pagination** — cursor-based. Offset pagination is unsafe on a table taking ' +
        'thousands of inserts a minute: rows shift between pages, so callers see ' +
        'duplicates and miss records.\n\n' +
        '**Idempotency** — send `Idempotency-Key` on job creation. A retried request ' +
        'returns the original job with `200` and `X-Idempotent-Replay: true`.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', name: 'X-API-Key', in: 'header' }, 'api-key')
    .build();

  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config), {
    jsonDocumentUrl: 'docs-json',
    swaggerOptions: { persistAuthorization: true },
  });

  // Docker sends SIGTERM; without this the process is SIGKILLed after the grace
  // period with in-flight requests still open.
  app.enableShutdownHooks();

  const port = Number(process.env['API_PORT'] ?? 3000);
  await app.listen(port, '0.0.0.0');

  logger.log(`API listening on :${port}  ·  docs at /docs  ·  metrics at /metrics`);
}

bootstrap().catch((err) => {
  console.error('API failed to start:', err);
  process.exit(1);
});
