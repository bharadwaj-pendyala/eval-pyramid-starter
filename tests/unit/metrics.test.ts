import { describe, expect, it } from 'vitest';

import {
  computeReliabilitySummary,
  passAtK,
  passPowerK,
} from '../../src/harness/metrics.js';
import { completed, invalid } from '../../src/harness/outcomes.js';
import type {
  ReleaseThresholds,
  TrialOutcome,
  TrialRecord,
} from '../../src/types.js';

const thresholds: ReleaseThresholds = {
  deterministicPassRate: 0.5,
  passAt1: 0.5,
  passPowerK: 0.5,
  judgeAverage: 0.5,
  maxInvalidRate: 0.5,
};

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
    const summary = computeReliabilitySummary(
      records,
      1,
      'metrics-test',
      thresholds
    );

    expect(summary.tasks.map((item) => item.taskId)).toEqual([
      'a-task',
      'b-task',
    ]);
    expect(summary.judgeAverage).toBe(0.5);
    expect(summary.scoredTrialCount).toBe(2);
    expect(summary.invalidTrialCount).toBe(0);
    expect(summary.releaseGate.passed).toBe(true);
    expect(summary.releaseGate.checks.map((check) => check.name)).toEqual([
      'deterministic pass rate',
      'pass@1',
      'pass^k',
      'invalid trial rate',
      'judge average',
    ]);
  });

  it('keeps invalid trials out of every rate', () => {
    const records = [
      record('a-task', true, 1),
      record('a-task', false, 0, invalid('system_error', 'adapter exploded')),
    ];
    const summary = computeReliabilitySummary(
      records,
      1,
      'invalid-test',
      thresholds
    );
    const task = summary.tasks[0];

    expect(summary.trialCount).toBe(2);
    expect(summary.scoredTrialCount).toBe(1);
    expect(summary.invalidRate).toBe(0.5);
    expect(task?.trials).toBe(2);
    expect(task?.scoredTrials).toBe(1);
    expect(task?.invalidTrials).toBe(1);
    // The one trial that measured anything passed, so the rate is 100%.
    expect(summary.passAt1).toBe(1);
    expect(summary.deterministicPassRate).toBe(1);
    expect(summary.judgeAverage).toBe(1);
  });

  it('still counts the deterministic layer when only the judge was lost', () => {
    const records = [
      record('a-task', true, 1),
      record('a-task', false, 0, invalid('judge_error', 'judge unavailable')),
    ];
    const summary = computeReliabilitySummary(
      records,
      1,
      'judge-outage',
      thresholds
    );

    // The judge measured nothing, but the deterministic graders both ran.
    expect(summary.judgeAverage).toBe(1);
    expect(summary.deterministicPassRate).toBe(0.5);
    expect(summary.scoredTrialCount).toBe(1);
  });

  it('reports spend and duration over the trials that ran', () => {
    const records = [
      record('a-task', true, 1),
      record('a-task', false, 0, invalid('system_error', 'provider down')),
    ];
    const summary = computeReliabilitySummary(
      records,
      1,
      'cost-test',
      thresholds
    );

    // The invalid trial reports a zeroed run; including it would understate both.
    expect(summary.totalCostUsd).toBeCloseTo(0.02, 10);
    expect(summary.medianTrialDurationMs).toBe(120);
    expect(summary.tasks[0]?.meanCostUsd).toBeCloseTo(0.02, 10);
    expect(summary.tasks[0]?.medianDurationMs).toBe(120);
  });

  it('fails the gate when too many trials measured nothing', () => {
    const records = [
      record('a-task', true, 1),
      record('a-task', true, 1, invalid('harness_error', 'disk full')),
      record('a-task', true, 1, invalid('harness_error', 'disk full')),
    ];
    const summary = computeReliabilitySummary(records, 1, 'gate-test', {
      ...thresholds,
      maxInvalidRate: 0.1,
    });
    const check = summary.releaseGate.checks.find(
      (item) => item.name === 'invalid trial rate'
    );

    expect(check).toMatchObject({ mode: 'maximum', passed: false });
    expect(summary.releaseGate.passed).toBe(false);
  });

  it('reports nothing rather than zero when a sample is too small for k', () => {
    const records = [
      record('a-task', true, 1),
      record('a-task', false, 0, invalid('judge_error', 'judge unavailable')),
    ];
    const summary = computeReliabilitySummary(
      records,
      2,
      'small-sample',
      thresholds
    );
    const task = summary.tasks[0];

    expect(task?.passAt1).toBe(1);
    expect(task?.passAtK).toBeNull();
    expect(task?.passPowerK).toBeNull();
    expect(summary.passPowerK).toBeNull();
    expect(
      summary.releaseGate.checks.find((check) => check.name === 'pass^k')
        ?.passed
    ).toBe(false);
  });

  it('rejects empty records and k larger than a task sample', () => {
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
  judgeScore: number,
  outcome: TrialOutcome = completed()
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
        costUsd: outcome.scored ? 0.02 : 0,
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
    outcome,
    attempts: 1,
    durationMs: outcome.scored ? 120 : null,
    warnings: [],
    error: outcome.detail,
    // A judge outage still leaves a deterministic result behind; the other
    // invalid statuses mean the deterministic layer never ran.
    deterministicPassed:
      outcome.scored || outcome.status === 'judge_error' ? passed : null,
    judgePassed: passed,
    passed,
  };
}
