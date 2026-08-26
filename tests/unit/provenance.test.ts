import { describe, expect, it } from 'vitest';

import { computeProvenance, digest } from '../../src/harness/provenance.js';
import type { EvalTask, ReleaseThresholds } from '../../src/types.js';

const thresholds: ReleaseThresholds = {
  deterministicPassRate: 1,
  passAt1: 1,
  passPowerK: 1,
  judgeAverage: 1,
  maxInvalidRate: 0,
};

const task: EvalTask = {
  id: 'digest-task',
  description: 'A task used to check digest stability.',
  input: { customerId: 'test', message: 'Anything at all.' },
  expected: { maxTurns: 1 },
};

describe('run provenance', () => {
  it('ignores key order but not content', () => {
    expect(digest({ a: 1, b: [2, 3] })).toBe(digest({ b: [2, 3], a: 1 }));
    expect(digest({ a: 1 })).not.toBe(digest({ a: 2 }));
    expect(digest({ a: 1 })).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('records what a run measured and how it was configured', async () => {
    const provenance = await computeProvenance({
      tasks: [task],
      thresholds,
      trials: 3,
      k: 2,
      concurrency: 2,
      systemUnderTest: 'fake',
      judge: 'fake-signal-judge',
      taskFile: 'evals/tasks.jsonl',
    });

    expect(provenance.taskDigests).toEqual([
      { taskId: 'digest-task', digest: digest(task as never) },
    ]);
    expect(provenance.judge).toBe('fake-signal-judge');
    expect(provenance.nodeVersion).toBe(process.version);
    expect(provenance.starterVersion).not.toBe('');
  });

  it('changes the config digest when a threshold moves', async () => {
    const base = {
      tasks: [task],
      thresholds,
      trials: 1,
      k: 1,
      concurrency: 1,
      systemUnderTest: 'fake',
    };
    const original = await computeProvenance(base);
    const loosened = await computeProvenance({
      ...base,
      thresholds: { ...thresholds, passAt1: 0.5 },
    });

    expect(original.taskSetDigest).toBe(loosened.taskSetDigest);
    expect(original.configDigest).not.toBe(loosened.configDigest);
  });
});
