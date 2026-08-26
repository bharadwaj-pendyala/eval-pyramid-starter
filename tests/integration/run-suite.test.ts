import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FakeRefundAgentFactory } from '../../src/adapters/fake-refund-agent.js';
import { runSuite } from '../../src/harness/run-suite.js';
import { loadTasks } from '../../src/loaders/tasks.js';

describe('eval harness', () => {
  it('runs isolated repeated trials and writes reviewable reports', async () => {
    const reportDirectory = await mkdtemp(
      join(tmpdir(), 'eval-pyramid-reports-')
    );

    try {
      const result = await runSuite({
        tasks: await loadTasks('evals/tasks.jsonl'),
        factory: new FakeRefundAgentFactory({ failureEvery: 2 }),
        trials: 2,
        k: 2,
        concurrency: 2,
        thresholds: {
          deterministicPassRate: 1,
          passAt1: 0.8,
          passPowerK: 0.5,
          judgeAverage: 0.8,
          maxInvalidRate: 0,
        },
        reportDirectory,
        runId: 'integration-test',
        systemLabel: 'fake',
        taskFile: 'evals/tasks.jsonl',
      });

      expect(result.records).toHaveLength(6);
      expect(result.records.filter((record) => record.passed)).toHaveLength(3);
      expect(result.summary.scoredTrialCount).toBe(6);
      expect(result.summary.invalidTrialCount).toBe(0);
      expect(result.summary.passAt1).toBe(0.5);
      expect(result.summary.passPowerK).toBe(0);
      expect(result.summary.releaseGate.passed).toBe(false);
      expect(result.summary.provenance?.taskFile).toBe('evals/tasks.jsonl');

      const reviewQueue = await readFile(
        join(reportDirectory, 'review-queue.jsonl'),
        'utf8'
      );
      const trialLines = await readFile(
        join(reportDirectory, 'trials.jsonl'),
        'utf8'
      );
      const failures = await readFile(
        join(reportDirectory, 'failures.md'),
        'utf8'
      );
      const html = await readFile(join(reportDirectory, 'index.html'), 'utf8');
      expect(reviewQueue.trim().split('\n')).toHaveLength(3);
      expect(trialLines).toContain('"inputTokens":180');
      expect(trialLines).toContain('"outputTokens":72');
      expect(failures).toContain('# Invalid trials');
      expect(failures).toContain('No invalid trials.');
      expect(html).toContain('Eval Pyramid Report');
      expect(html).toContain('integration-test');
      expect(html).toContain('Provenance');
    } finally {
      await rm(reportDirectory, { recursive: true, force: true });
    }
  });

  it('proves the tasks with both controls before a model is involved', async () => {
    const reportDirectory = await mkdtemp(
      join(tmpdir(), 'eval-pyramid-controls-')
    );
    const tasks = await loadTasks('evals/tasks.jsonl');
    const thresholds = {
      deterministicPassRate: 1,
      passAt1: 1,
      passPowerK: 1,
      judgeAverage: 1,
      maxInvalidRate: 0,
    };

    try {
      const { OracleAgentFactory } =
        await import('../../src/adapters/oracle-agent.js');
      const { NopAgentFactory } =
        await import('../../src/adapters/nop-agent.js');

      const oracle = await runSuite({
        tasks,
        factory: new OracleAgentFactory(),
        trials: 1,
        k: 1,
        concurrency: 2,
        thresholds,
        reportDirectory,
        systemLabel: 'oracle',
      });
      expect(oracle.records.every((record) => record.passed)).toBe(true);

      const nop = await runSuite({
        tasks,
        factory: new NopAgentFactory(),
        trials: 1,
        k: 1,
        concurrency: 2,
        thresholds,
        reportDirectory,
        systemLabel: 'nop',
      });
      expect(nop.records.some((record) => record.passed)).toBe(false);
    } finally {
      await rm(reportDirectory, { recursive: true, force: true });
    }
  });
});
