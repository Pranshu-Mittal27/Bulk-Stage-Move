import 'dotenv/config';
import {
  assertDatabaseCredentialsConfigured,
  PrismaService,
} from '../src/database/prisma.service.js';

async function checkDatabase(): Promise<void> {
  let prisma: PrismaService;
  try {
    assertDatabaseCredentialsConfigured();
    prisma = new PrismaService();
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Database configuration error: ${error.message}`);
    } else {
      console.error('Database configuration error: unable to initialize Prisma.');
    }
    process.exitCode = 1;
    return;
  }

  let failed = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    console.error(
      'Database connection failed. Check DATABASE_URL, PostgreSQL availability, and database access.',
    );
    failed = true;
  }

  try {
    await prisma.$disconnect();
  } catch {
    console.error('Database connection check could not close the Prisma connection cleanly.');
    failed = true;
  }

  if (failed) {
    process.exitCode = 1;
  } else {
    console.log('Database connection successful: SELECT 1 completed.');
  }
}

await checkDatabase();
