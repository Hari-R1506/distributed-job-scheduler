import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@djs/db';

/**
 * The API's Prisma client.
 *
 * Pool of 10: every query here is short and indexed. The API deliberately holds
 * no long transactions — it never executes jobs, so it never needs one.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: ConfigService) {
    const url = new URL(config.getOrThrow<string>('DATABASE_URL'));
    url.searchParams.set('connection_limit', '10');
    url.searchParams.set('pool_timeout', '10');
    super({ datasources: { db: { url: url.toString() } }, log: ['warn', 'error'] });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
