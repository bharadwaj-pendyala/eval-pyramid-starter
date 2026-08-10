import { describe, expect, it } from 'vitest';

import {
  computeReliabilitySummary,
  passAtK,
  passPowerK,
} from '../../src/harness/metrics.js';
import type { TrialRecord } from '../../src/types.js';

describe('reliability estimators', () => {
  it('computes finite-sample pass@k and pass^k', () => {
    expect(passAtK(75, 100, 3)).toBeCloseTo(0.9857761286, 10);
    expect(passPowerK(75, 100, 3)).toBeCloseTo(0.4175943105, 10);
  });

  it('handles all-pass and all-fail samples', () => {
    expect(passAtK(10, 10, 3)).toBe(1);
    expect(passPowerK(10, 10, 3)).toBe(1);
    expect(passAtK(0, 10, 3)).toBe(0);
    expect(passPowerK(0, 10, 3)).toBe(0);
  });

  it('rejects invalid counts', () => {
    expect(() => passAtK(11, 10, 3)).toThrow('Invalid reliability counts');
    expect(() => passPowerK(5, 10, 11)).toThrow('Invalid reliability counts');
    expect(() => passAtK(1.5, 10, 1)).toThrow('must be integers');
  });

  it('summarizes task and judge reliability against release gates', () => {
    const records = [record('b-task', true, 1), record('a-task', false, 0)];
    const summary = computeReliabilitySummary(records, 1, 'metrics-test', {
      deterministicPassRate: 0.5,
      passAt1: 0.5,
      passPowerK: 0.5,
      judgeAverage: 0.5,
    });

    expect(summary.tasks.map((item) => item.taskId)).toEqual([
      'a-task',
      'b-task',
    ]);
    expect(summary.judgeAverage).toBe(0.5);
    expect(summary.releaseGate.passed).toBe(true);
    expect(summary.releaseGate.checks).toHaveLength(4);
  });

  it('rejects empty records and k larger than a task sample', () => {
    const thresholds = {
      deterministicPassRate: 1,
      passAt1: 1,
      passPowerK: 1,
      judgeAverage: 1,
    };

    expect(() => computeReliabilitySummary([], 1, 'empty', thresholds)).toThrow(
      'Cannot summarize an empty eval run'
    );
    expect(() =>
      computeReliabilitySummary(
        [record('one', true, 1)],
        2,
        'too-large',
        thresholds
      )
    ).toThrow('k=2 exceeds 1 trials');
  });
});

function record(
  taskId: string,
  passed: boolean,
  judgeScore: number
): TrialRecord {
  return {
    taskId,
    trialIndex: 0,
    run: {
      output: {},
      outcome: {},
      transcript: [],
      toolCalls: [],
      metrics: {
        latencyMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        turns: 1,
      },
    },
    grades: [
      {
        grader: 'judge:quality',
        score: judgeScore,
        passed,
        rationale: 'Test judge result.',
      },
    ],
    error: null,
    deterministicPassed: passed,
    judgePassed: passed,
    passed,
  };
}
