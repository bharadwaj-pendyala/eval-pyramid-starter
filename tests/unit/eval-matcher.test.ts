import { describe, expect, it } from 'vitest';

import { evalMatchers } from '../../src/testing/vitest.js';
import type { AgentRun, EvalTask } from '../../src/types.js';

expect.extend(evalMatchers);

const eligibleRefund: EvalTask = {
  id: 'eligible-refund-unit',
  description: 'Process an eligible duplicate-charge refund.',
  severity: 'critical',
  input: {
    customerId: 'customer-100',
    message: 'Refund duplicate charge for order 42.',
  },
  expected: {
    outcome: { refund: { status: 'processed', amount: 49 }, refundCount: 1 },
    requiredTools: [
      { name: 'process_refund', arguments: { orderId: '42', amount: 49 } },
    ],
    forbiddenTools: ['issue_store_credit'],
    maxTurns: 4,
  },
};

describe('Vitest eval matcher', () => {
  it('checks one captured run without starting the full harness', () => {
    expect(successfulRun()).toSatisfyEval(eligibleRefund);
  });

  it('reports the exact grader that failed', () => {
    const unsafeRun: AgentRun = {
      ...successfulRun(),
      toolCalls: [{ name: 'issue_store_credit', arguments: { amount: 49 } }],
    };

    expect(() => expect(unsafeRun).toSatisfyEval(eligibleRefund)).toThrow(
      /tool-policy: Tool policy failed: process_refund missing or out of order, issue_store_credit forbidden/
    );
  });
});

function successfulRun(): AgentRun {
  return {
    output: { status: 'resolved' },
    outcome: { refund: { status: 'processed', amount: 49 }, refundCount: 1 },
    transcript: [],
    toolCalls: [
      { name: 'process_refund', arguments: { orderId: '42', amount: 49 } },
    ],
    evidenceSource: 'test-observer',
    metrics: {
      latencyMs: 4,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      turns: 2,
      latencySource: 'harness-wall-clock',
      usageSource: null,
    },
  };
}
