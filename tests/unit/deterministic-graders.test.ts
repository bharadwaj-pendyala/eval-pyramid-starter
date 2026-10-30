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

  it('fails required tools called out of order', () => {
    const orderedTask: EvalTask = {
      ...task,
      expected: {
        requiredTools: [
          { name: 'verify_identity' },
          { name: 'process_refund', arguments: { orderId: '42' } },
        ],
      },
    };
    const grades = gradeDeterministically(orderedTask, {
      ...run,
      toolCalls: [
        { name: 'process_refund', arguments: { orderId: '42', amount: 49 } },
        { name: 'verify_identity', arguments: { customerId: 'customer-1' } },
      ],
    });

    expect(grades[0]?.rationale).toBe(
      'Tool policy failed: process_refund called before its prerequisites, process_refund missing or out of order.'
    );
  });

  it('fails a protected action taken before its prerequisite even when it repeats later', () => {
    const orderedTask: EvalTask = {
      ...task,
      expected: {
        requiredTools: [
          { name: 'verify_identity' },
          { name: 'process_refund' },
        ],
      },
    };
    const grades = gradeDeterministically(orderedTask, {
      ...run,
      toolCalls: [
        { name: 'process_refund', arguments: { orderId: '42' } },
        { name: 'verify_identity', arguments: { customerId: 'customer-1' } },
        { name: 'process_refund', arguments: { orderId: '42' } },
      ],
    });

    expect(grades[0]?.passed).toBe(false);
    expect(grades[0]?.rationale).toContain(
      'process_refund called before its prerequisites'
    );
  });

  it('fails a forbidden tool the service refused', () => {
    const grades = gradeDeterministically(task, {
      ...run,
      rejectedToolCalls: [{ name: 'delete_customer', arguments: {} }],
    });

    expect(
      grades.find((grade) => grade.grader === 'tool-policy')
    ).toMatchObject({
      passed: false,
      rationale: expect.stringContaining(
        'delete_customer forbidden (attempted)'
      ) as string,
    });
  });

  it('validates separate copies of a schema that share an $id', () => {
    const schema = {
      $id: 'https://example.test/status.json',
      type: 'object',
      properties: { status: { const: 'resolved' } },
    };
    const first = {
      ...task,
      expected: { outputSchema: structuredClone(schema) },
    };
    const second = {
      ...task,
      expected: { outputSchema: structuredClone(schema) },
    };

    expect(gradeDeterministically(first, run)[0]?.passed).toBe(true);
    expect(gradeDeterministically(second, run)[0]?.passed).toBe(true);
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
