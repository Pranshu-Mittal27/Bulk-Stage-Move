import 'dotenv/config';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

export function getDatabaseConnectionString(): string {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Configure it in the local .env file.',
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL is not a valid PostgreSQL connection URL.');
  }

  if (
    parsedUrl.protocol !== 'postgresql:' &&
    parsedUrl.protocol !== 'postgres:'
  ) {
    throw new Error(
      'DATABASE_URL must use the postgresql:// or postgres:// protocol.',
    );
  }

  return connectionString;
}

export function assertDatabaseCredentialsConfigured(): void {
  const parsedUrl = new URL(getDatabaseConnectionString());
  if (
    !parsedUrl.username ||
    !parsedUrl.password ||
    parsedUrl.username === 'USER' ||
    parsedUrl.password === 'PASSWORD'
  ) {
    throw new Error(
      'DATABASE_URL must contain your PostgreSQL username and password, not the example placeholders.',
    );
  }
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({
      adapter: new PrismaPg({
        connectionString: getDatabaseConnectionString(),
      }),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
