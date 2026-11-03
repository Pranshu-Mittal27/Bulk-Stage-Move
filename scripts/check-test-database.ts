import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import {
  assertConnectedDatabaseMatchesConfirmation,
  assertDatabaseUrlMatchesConfirmation,
} from './assignment-seed-safety.js';

const confirmedDatabaseName = 'ghl_bulk_stage_test';
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not configured.');
}

assertDatabaseUrlMatchesConfirmation(connectionString, confirmedDatabaseName);

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

try {
  const rows = await prisma.$queryRaw<{ databaseName: string }[]>`
    SELECT current_database() AS "databaseName"
  `;
  assertConnectedDatabaseMatchesConfirmation(
    rows[0]?.databaseName,
    confirmedDatabaseName,
  );
  console.log(`Verified connection to ${confirmedDatabaseName}.`);
} finally {
  await prisma.$disconnect();
}
