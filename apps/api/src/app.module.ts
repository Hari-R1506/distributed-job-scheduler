import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Response } from 'express';

import { PrismaService } from './prisma.service.js';
import { AppExceptionFilter } from './common/errors.js';
import { AuthGuard, TenancyService, type AuthedRequest } from './common/guards.js';
import { AuthService } from './modules/auth/auth.service.js';
import { AuthController } from './modules/auth/auth.controller.js';
import { ProjectsController } from './modules/projects/projects.controller.js';
import { QueuesController } from './modules/queues/queues.controller.js';
import { QueueStatsService } from './modules/queues/queue-stats.service.js';
import { JobsController } from './modules/jobs/jobs.controller.js';
import { JobsService } from './modules/jobs/jobs.service.js';
import { SchedulesController } from './modules/schedules/schedules.controller.js';
import { WorkersController } from './modules/workers/workers.controller.js';
import { DlqController } from './modules/dlq/dlq.controller.js';
import { MetricsController } from './modules/metrics/metrics.controller.js';
import { HealthController } from './modules/health/health.controller.js';

/**
 * Correlation id.
 *
 * Minted here (or accepted from an inbound X-Request-Id), stored on every job
 * this request creates, and re-attached by the worker on every log line it
 * writes. One grep then answers "what happened to the request that created this
 * job", across three processes and two retries (ARCHITECTURE.md §20.2).
 */
function requestId(req: AuthedRequest, res: Response, next: NextFunction): void {
  req.requestId = req.header('x-request-id') ?? `req_${randomUUID()}`;
  res.setHeader('x-request-id', req.requestId);
  next();
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    JwtModule.register({}),
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 300 },
      // Login is rate limited far harder than everything else: it is the one
      // endpoint where an attacker's cost per attempt is the whole defence.
      { name: 'auth', ttl: 60_000, limit: 10 },
    ]),
  ],
  controllers: [
    AuthController,
    ProjectsController,
    QueuesController,
    JobsController,
    SchedulesController,
    WorkersController,
    DlqController,
    MetricsController,
    HealthController,
  ],
  providers: [
    PrismaService,
    AuthService,
    TenancyService,
    JobsService,
    QueueStatsService,
    // Auth is DENY BY DEFAULT: every route requires a principal unless it
    // carries @Public(). Opt-in auth is how endpoints ship unprotected.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(requestId).forRoutes('*');
  }
}
