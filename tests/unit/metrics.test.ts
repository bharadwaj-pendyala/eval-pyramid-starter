import { describe, expect, it } from 'vitest';

import {
  computeReliabilitySummary,
  passAtK,
  passPowerK,
} from '../../src/harness/metrics.js';
import type { ReleaseThresholds, TrialRecord } from '../../src/types.js';

const thresholds: ReleaseThresholds = {
  deterministicPassRate: 0.5,
  passAt1: 0.5,
  passPowerK: 0.5,
  judgeAverage: 0.5,
  criticalPassRate: 1,
  requireJudge: true,
  requireIndependentEvidence: true,
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

  it('stays finite where binomial coefficients overflow', () => {
    expect(passAtK(0, 2000, 1000)).toBe(0);
    expect(passPowerK(2000, 2000, 1000)).toBe(1);
    expect(passAtK(1, 2000, 1000)).toBeCloseTo(0.5, 10);
  });

  it('rejects invalid counts', () => {
    expect(() => passAtK(11, 10, 3)).toThrow('Invalid reliability counts');
    expect(() => passPowerK(5, 10, 11)).toThrow('Invalid reliability counts');
    expect(() => passAtK(1.5, 10, 1)).toThrow('must be integers');
  });

  it('summarizes task, severity, judge, and evidence gates', () => {
    const records = [
      record('b-task', true, 1, 'medium'),
      record('a-task', false, 0, 'medium'),
    ];
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
    expect(summary.independentEvidenceRate).toBe(1);
    expect(summary.releaseGate.passed).toBe(true);
    expect(summary.releaseGate.checks).toHaveLength(6);
  });

  it('fails closed when required judge evidence is missing', () => {
    const item = record('critical-task', true, 1, 'critical');
    item.grades = item.grades.filter(
      (grade) => !grade.grader.startsWith('judge:')
    );
    item.judgePassed = null;

    const summary = computeReliabilitySummary(
      [item],
      1,
      'missing-judge',
      thresholds
    );

    expect(summary.releaseGate.passed).toBe(false);
    expect(
      summary.releaseGate.checks.find((check) => check.name === 'judge average')
    ).toMatchObject({ actual: null, passed: false });
  });

  it('fails critical and self-reported evidence gates independently', () => {
    const item = record('critical-task', false, 1, 'critical');
    item.run.evidenceSource = 'self-reported:application';
    const summary = computeReliabilitySummary([item], 1, 'unsafe-evidence', {
      ...thresholds,
      deterministicPassRate: 0,
      passAt1: 0,
      passPowerK: 0,
    });

    expect(summary.criticalPassRate).toBe(0);
    expect(summary.independentEvidenceRate).toBe(0);
    expect(summary.releaseGate.passed).toBe(false);
  });

  it('rejects empty records and k larger than a task sample', () => {
    expect(() => computeReliabilitySummary([], 1, 'empty', thresholds)).toThrow(
      'Cannot summarize an empty eval run'
    );
    expect(() =>
      computeReliabilitySummary(
        [record('one', true, 1, 'medium')],
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
  severity: TrialRecord['severity']
): TrialRecord {
  return {
    taskId,
    severity,
    trialIndex: 0,
    run: {
      output: {},
      outcome: {},
      transcript: [],
      toolCalls: [],
      evidenceSource: 'test-observer',
      metrics: {
        latencyMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        turns: 1,
        latencySource: 'harness-wall-clock',
        usageSource: 'test-provider',
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
