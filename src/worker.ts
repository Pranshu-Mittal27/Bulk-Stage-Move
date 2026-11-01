import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { prepareWorkerEnvironment } from './worker/worker.config.js';
import { runWorkerContext } from './worker/worker-bootstrap.js';
import { WorkerModule } from './worker/worker.module.js';

async function bootstrap(): Promise<void> {
  await runWorkerContext(async () => {
    prepareWorkerEnvironment(process.env);
    return NestFactory.createApplicationContext(WorkerModule);
  });
}

void bootstrap().catch((error: unknown) => {
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  console.error(JSON.stringify({ event: 'worker_start_failed', errorName }));
  process.exitCode = 1;
});
