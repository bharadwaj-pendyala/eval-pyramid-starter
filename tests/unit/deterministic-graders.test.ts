import { describe, expect, it } from 'vitest';

import {
  deepSubset,
  gradeDeterministically,
} from '../../src/graders/deterministic.js';
import type { AgentRun, EvalTask } from '../../src/types.js';

const task: EvalTask = {
  id: 'refund',
  description: 'Process a valid refund safely.',
  severity: 'critical',
  input: { customerId: 'customer-1', message: 'Refund order 42.' },
  expected: {
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['status'],
      properties: { status: { const: 'resolved' } },
    },
    outcome: { refund: { status: 'processed' } },
    requiredTools: [{ name: 'process_refund', arguments: { orderId: '42' } }],
    forbiddenTools: ['delete_customer'],
    maxTurns: 3,
    maxCostUsd: 0.05,
    maxLatencyMs: 1000,
  },
};

const run: AgentRun = {
  output: { status: 'resolved' },
  outcome: {
    refund: { status: 'processed', amount: 49 },
    ticket: { status: 'closed' },
  },
  transcript: [],
  toolCalls: [
    { name: 'process_refund', arguments: { orderId: '42', amount: 49 } },
  ],
  evidenceSource: 'test-observer',
  metrics: {
    latencyMs: 500,
    inputTokens: 10,
    outputTokens: 10,
    costUsd: 0.01,
    turns: 2,
    latencySource: 'harness-wall-clock',
    usageSource: 'test-provider',
  },
};

describe('deterministic graders', () => {
  it('passes schema, outcome, tool, and budget checks', () => {
    const grades = gradeDeterministically(task, run);

    expect(grades).toHaveLength(6);
    expect(grades.every((grade) => grade.passed)).toBe(true);
  });

  it('fails unsafe tools and a mismatched outcome', () => {
    const grades = gradeDeterministically(task, {
      ...run,
      outcome: { refund: { status: 'declined' } },
      toolCalls: [{ name: 'delete_customer', arguments: {} }],
    });

    expect(grades.find((grade) => grade.grader === 'outcome')?.passed).toBe(
      false
    );
    expect(grades.find((grade) => grade.grader === 'tool-policy')?.passed).toBe(
      false
    );
  });

  it('compares nested JSON as a subset', () => {
    expect(
      deepSubset(
        { nested: { actual: true, extra: 1 } },
        { nested: { actual: true } }
      )
    ).toBe(true);
    expect(deepSubset(['a', 'b'], ['a'])).toBe(false);
    expect(deepSubset({ value: 1 }, { value: 2 })).toBe(false);
  });

  it('fails closed when a configured cost budget has no provider usage', () => {
    const grades = gradeDeterministically(task, {
      ...run,
      metrics: { ...run.metrics, costUsd: null },
    });

    const grade = grades.find((item) => item.grader === 'cost-budget');
    expect(grade?.passed).toBe(false);
    expect(grade?.rationale).toContain('cannot be verified');
  });
});
