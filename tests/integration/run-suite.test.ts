import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { RefundAgentFactory } from '../../src/examples/refund-agent/environment.js';
import { runSuite } from '../../src/harness/run-suite.js';
import { loadTasks } from '../../src/loaders/tasks.js';
import type { ReleaseThresholds } from '../../src/types.js';

const thresholds: ReleaseThresholds = {
  deterministicPassRate: 1,
  passAt1: 1,
  passPowerK: 1,
  judgeAverage: 0.8,
  criticalPassRate: 1,
  requireJudge: false,
  requireIndependentEvidence: true,
};

describe('real example eval stack', () => {
  it('runs repeated isolated trials across application and tool HTTP sockets', async () => {
    const reportRoot = await mkdtemp(join(tmpdir(), 'eval-reports-'));

    try {
      const result = await runSuite({
        tasks: await loadTasks('evals/tasks.jsonl'),
        factory: new RefundAgentFactory(),
        trials: 2,
        k: 2,
        concurrency: 2,
        thresholds,
        reportRoot,
        runId: 'integration-test',
      });

      expect(result.records).toHaveLength(12);
      expect(result.records.every((record) => record.passed)).toBe(true);
      expect(
        result.records.every((record) =>
          record.run.evidenceSource.includes('persisted-state')
        )
      ).toBe(true);
      expect(result.summary.passAt1).toBe(1);
      expect(result.summary.passPowerK).toBe(1);
      expect(result.summary.releaseGate.passed).toBe(true);
      expect(result.summary.judgeAverage).toBeNull();

      const trialLines = await readFile(
        join(result.latestDirectory, 'trials.jsonl'),
        'utf8'
      );
      const html = await readFile(
        join(result.latestDirectory, 'index.html'),
        'utf8'
      );
      expect(trialLines).toContain('"latencySource":"harness-wall-clock"');
      expect(trialLines).toContain(
        '"usageSource":"example-rule-agent:no-model-provider"'
      );
      expect(html).toContain('Independent evidence');
      expect(html).toContain('integration-test');
      await expect(
        access(join(result.runDirectory, 'summary.json'))
      ).resolves.toBeUndefined();
    } finally {
      await rm(reportRoot, { recursive: true, force: true });
    }
  });
});
