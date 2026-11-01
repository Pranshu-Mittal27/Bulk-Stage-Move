import type { INestApplicationContext } from '@nestjs/common';
import { BulkJobWorkerService } from './worker.service.js';

type WorkerSignal = 'SIGINT' | 'SIGTERM';

interface WorkerSignalSource {
  once(signal: WorkerSignal, listener: () => void): unknown;
  removeListener(signal: WorkerSignal, listener: () => void): unknown;
}

interface WorkerApplicationContext {
  get<TInput, TResult = TInput>(
    token: new (...args: never[]) => TInput,
  ): TResult;
  close(): Promise<void>;
}

function logSecondaryCleanupError(error: unknown): void {
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  console.error(
    JSON.stringify({
      event: 'worker_cleanup_failed_after_error',
      errorName,
    }),
  );
}

export async function runWorkerContext(
  createContext: () => Promise<
    INestApplicationContext & WorkerApplicationContext
  >,
  signals: WorkerSignalSource = process,
  reportSecondaryCleanupError = logSecondaryCleanupError,
): Promise<void> {
  const app = await createContext();
  let shutdown: (() => void) | undefined;
  let hasPrimaryError = false;
  let primaryError: unknown;

  try {
    const worker = app.get(BulkJobWorkerService);
    shutdown = () => worker.requestShutdown();
    signals.once('SIGINT', shutdown);
    signals.once('SIGTERM', shutdown);
    await worker.run();
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (shutdown) {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      try {
        signals.removeListener(signal, shutdown);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }

  try {
    await app.close();
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (hasPrimaryError) {
    if (cleanupErrors.length > 0) {
      const cleanupError =
        cleanupErrors.length === 1
          ? cleanupErrors[0]
          : new AggregateError(
              cleanupErrors,
              'Worker signal listener cleanup and application context close failed.',
            );
      try {
        reportSecondaryCleanupError(cleanupError);
      } catch {
        // The startup or run failure remains the primary error.
      }
    }
    throw primaryError;
  }
  if (cleanupErrors.length === 1) {
    throw cleanupErrors[0];
  }
  if (cleanupErrors.length > 1) {
    throw new AggregateError(
      cleanupErrors,
      'Worker signal listener cleanup and application context close failed.',
    );
  }
}
