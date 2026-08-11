import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { RefundAgentFactory } from '../../src/examples/refund-agent/refund-agent.js';
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
        factory: new RefundAgentFactory({ failureEvery: 2 }),
        trials: 2,
        k: 2,
        concurrency: 2,
        thresholds: {
          deterministicPassRate: 1,
          passAt1: 0.8,
          passPowerK: 0.5,
          judgeAverage: 0.8,
        },
        reportDirectory,
        runId: 'integration-test',
      });

      expect(result.records).toHaveLength(6);
      expect(result.records.filter((record) => record.passed)).toHaveLength(3);
      expect(result.summary.passAt1).toBe(0.5);
      expect(result.summary.passPowerK).toBe(0);
      expect(result.summary.releaseGate.passed).toBe(false);

      const reviewQueue = await readFile(
        join(reportDirectory, 'review-queue.jsonl'),
        'utf8'
      );
      const trialLines = await readFile(
        join(reportDirectory, 'trials.jsonl'),
        'utf8'
      );
      const html = await readFile(join(reportDirectory, 'index.html'), 'utf8');
      expect(reviewQueue.trim().split('\n')).toHaveLength(3);
      expect(trialLines).toContain('"inputTokens":180');
      expect(trialLines).toContain('"outputTokens":72');
      expect(html).toContain('Eval Pyramid Report');
      expect(html).toContain('integration-test');
    } finally {
      await rm(reportDirectory, { recursive: true, force: true });
    }
  });
});
