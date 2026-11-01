import { EventEmitter } from 'node:events';
import { describe, expect, it, jest } from '@jest/globals';
import type { INestApplicationContext } from '@nestjs/common';
import { runWorkerContext } from './worker-bootstrap.js';

describe('runWorkerContext', () => {
  it('closes the created context when worker provider resolution fails', async () => {
    const resolutionError = new Error('worker provider failed');
    const app = {
      get: jest.fn(() => {
        throw resolutionError;
      }),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(),
    } as unknown as INestApplicationContext;

    await expect(runWorkerContext(async () => app)).rejects.toBe(
      resolutionError,
    );
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it('removes signal listeners and closes the context after the worker stops', async () => {
    const signals = new EventEmitter();
    const worker = {
      requestShutdown: jest.fn(),
      run: jest.fn<() => Promise<void>>().mockImplementation(async () => {
        signals.emit('SIGTERM');
      }),
    };
    const app = {
      get: jest.fn(() => worker),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(),
    } as unknown as INestApplicationContext;

    await runWorkerContext(async () => app, signals);

    expect(worker.requestShutdown).toHaveBeenCalledTimes(1);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it('preserves the original error when context close also fails', async () => {
    const runError = new Error('worker run failed');
    const closeError = new Error('context close failed');
    const worker = {
      requestShutdown: jest.fn(),
      run: jest.fn<() => Promise<void>>().mockRejectedValue(runError),
    };
    const app = {
      get: jest.fn(() => worker),
      close: jest.fn<() => Promise<void>>().mockRejectedValue(closeError),
    } as unknown as INestApplicationContext;
    const reportSecondaryCleanupError = jest.fn();

    await expect(
      runWorkerContext(
        async () => app,
        new EventEmitter(),
        reportSecondaryCleanupError,
      ),
    ).rejects.toBe(runError);
    expect(reportSecondaryCleanupError).toHaveBeenCalledWith(closeError);
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it('propagates a context close error when worker execution succeeds', async () => {
    const closeError = new Error('context close failed');
    const worker = {
      requestShutdown: jest.fn(),
      run: jest.fn<() => Promise<void>>().mockResolvedValue(),
    };
    const app = {
      get: jest.fn(() => worker),
      close: jest.fn<() => Promise<void>>().mockRejectedValue(closeError),
    } as unknown as INestApplicationContext;

    await expect(runWorkerContext(async () => app)).rejects.toBe(closeError);
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it('preserves the worker error when cleanup reporting also throws', async () => {
    const runError = new Error('worker run failed');
    const closeError = new Error('context close failed');
    const reporterError = new Error('cleanup reporter failed');
    const worker = {
      requestShutdown: jest.fn(),
      run: jest.fn<() => Promise<void>>().mockRejectedValue(runError),
    };
    const app = {
      get: jest.fn(() => worker),
      close: jest.fn<() => Promise<void>>().mockRejectedValue(closeError),
    } as unknown as INestApplicationContext;
    const reportSecondaryCleanupError = jest.fn(() => {
      throw reporterError;
    });

    await expect(
      runWorkerContext(
        async () => app,
        new EventEmitter(),
        reportSecondaryCleanupError,
      ),
    ).rejects.toBe(runError);
    expect(reportSecondaryCleanupError).toHaveBeenCalledWith(closeError);
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it('attempts to remove both listeners when one removal fails', async () => {
    const removalError = new Error('SIGINT listener removal failed');
    const signals = {
      once: jest.fn(),
      removeListener: jest.fn((signal: 'SIGINT' | 'SIGTERM') => {
        if (signal === 'SIGINT') {
          throw removalError;
        }
      }),
    };
    const worker = {
      requestShutdown: jest.fn(),
      run: jest.fn<() => Promise<void>>().mockResolvedValue(),
    };
    const app = {
      get: jest.fn(() => worker),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(),
    } as unknown as INestApplicationContext;

    await expect(runWorkerContext(async () => app, signals)).rejects.toBe(
      removalError,
    );
    expect(signals.removeListener).toHaveBeenCalledTimes(2);
    expect(signals.removeListener).toHaveBeenNthCalledWith(
      2,
      'SIGTERM',
      expect.any(Function),
    );
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it('removes listeners and still attempts context close if worker resolution fails', async () => {
    const signals = new EventEmitter();
    const resolutionError = new Error('worker provider failed');
    const app = {
      get: jest.fn(() => {
        throw resolutionError;
      }),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(),
    } as unknown as INestApplicationContext;

    await expect(runWorkerContext(async () => app, signals)).rejects.toBe(
      resolutionError,
    );

    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    expect(app.close).toHaveBeenCalledTimes(1);
  });
});
