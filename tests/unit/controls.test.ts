import { describe, expect, it } from 'vitest';

import { FakeJudgeProvider } from '../../src/adapters/fake-judge.js';
import { runControls } from '../../src/harness/run-controls.js';
import { loadTasks } from '../../src/loaders/tasks.js';
import type { EvalTask } from '../../src/types.js';

describe('grader controls', () => {
  it('accepts the shipped tasks under both controls', async () => {
    const summary = await runControls(
      await loadTasks('evals/tasks.jsonl'),
      new FakeJudgeProvider()
    );

    expect(summary.passed).toBe(true);
    expect(summary.checks).toHaveLength(6);
    expect(summary.checks.every((check) => check.passed)).toBe(true);
  });

  it('flags a task whose expectations cannot detect a failure', async () => {
    const permissive: EvalTask = {
      id: 'permissive',
      description: 'A task whose only expectation any result satisfies.',
      input: { customerId: 'test', message: 'Anything at all.' },
      expected: { maxTurns: 10 },
      reference: { output: { message: 'A correct answer.' } },
    };

    const summary = await runControls([permissive]);
    const nop = summary.checks.find((check) => check.control === 'nop');

    expect(summary.passed).toBe(false);
    expect(nop?.passed).toBe(false);
    expect(nop?.detail).toContain('cannot detect a failure');
  });

  it('flags a task whose graders reject its own reference answer', async () => {
    const contradictory: EvalTask = {
      id: 'contradictory',
      description: 'A task whose reference answer breaks its own schema.',
      input: { customerId: 'test', message: 'Anything at all.' },
      expected: {
        outputSchema: {
          type: 'object',
          required: ['status'],
          properties: { status: { const: 'resolved' } },
        },
      },
      reference: { output: { status: 'escalated' } },
    };

    const summary = await runControls([contradictory]);
    const oracle = summary.checks.find((check) => check.control === 'oracle');

    expect(summary.passed).toBe(false);
    expect(oracle?.passed).toBe(false);
    expect(oracle?.detail).toContain('Rejected the reference answer');
  });

  it('reports a task that ships no reference answer', async () => {
    const unproven: EvalTask = {
      id: 'unproven',
      description: 'A task with no known-good answer to replay.',
      input: { customerId: 'test', message: 'Anything at all.' },
      expected: { maxTurns: 1 },
    };

    const summary = await runControls([unproven]);
    const oracle = summary.checks.find((check) => check.control === 'oracle');

    expect(oracle?.passed).toBe(false);
    expect(oracle?.detail).toContain('no reference answer');
  });

  it('requires at least one task', async () => {
    await expect(runControls([])).rejects.toThrow(
      'At least one task is required'
    );
  });
});
