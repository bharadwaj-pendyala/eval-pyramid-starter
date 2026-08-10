import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runSuite } from '../../src/harness/run-suite.js';
import type { SystemUnderTestFactory } from '../../src/types.js';
import type { EvalTask } from '../../src/types.js';

const task: EvalTask = {
  id: 'runtime-failure',
  description: 'Capture a runtime failure as a failed trial.',
  input: { customerId: 'test', message: 'Run the failing system.' },
  expected: { maxTurns: 1 },
};

const thresholds = {
  deterministicPassRate: 1,
  passAt1: 1,
  passPowerK: 1,
  judgeAverage: 1,
};

describe('run suite boundaries', () => {
  it('captures adapter failures, disposes the system, and creates a run id', async () => {
    const reportDirectory = await mkdtemp(
      join(tmpdir(), 'eval-pyramid-runtime-')
    );
    let disposed = false;
    const factory: SystemUnderTestFactory = {
      create: () =>
        Promise.resolve({
          run: () => Promise.reject(new Error('adapter exploded')),
          dispose: () => {
            disposed = true;
            return Promise.resolve();
          },
        }),
    };

    try {
      const result = await runSuite({
        tasks: [task],
        factory,
        trials: 1,
        k: 1,
        concurrency: 1,
        thresholds,
        reportDirectory,
      });

      expect(result.records[0]?.error).toBe('adapter exploded');
      expect(result.records[0]?.grades[0]?.grader).toBe('runtime');
      expect(result.summary.runId).not.toBe('');
      expect(disposed).toBe(true);
    } finally {
      await rm(reportDirectory, { recursive: true, force: true });
    }
  });

  it('rejects invalid suite options before running', async () => {
    const factory: SystemUnderTestFactory = {
      create: () => Promise.reject(new Error('must not create')),
    };
    const base = {
      tasks: [task],
      factory,
      trials: 1,
      k: 1,
      concurrency: 1,
      thresholds,
      reportDirectory: 'unused',
    };

    await expect(runSuite({ ...base, tasks: [] })).rejects.toThrow(
      'At least one task is required'
    );
    await expect(runSuite({ ...base, trials: 0 })).rejects.toThrow(
      'trials must be a positive integer'
    );
    await expect(runSuite({ ...base, k: 2 })).rejects.toThrow(
      'k must be a positive integer'
    );
    await expect(runSuite({ ...base, concurrency: 0 })).rejects.toThrow(
      'concurrency must be a positive integer'
    );
  });
});
