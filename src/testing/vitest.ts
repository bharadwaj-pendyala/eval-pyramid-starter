import type { MatcherResult } from 'vitest';

import { gradeDeterministically } from '../graders/deterministic.js';
import type { AgentRun, EvalTask } from '../types.js';

export const evalMatchers = {
  toSatisfyEval(received: AgentRun, task: EvalTask): MatcherResult {
    const grades = gradeDeterministically(task, received);
    const failures = grades.filter((grade) => !grade.passed);
    const passed = failures.length === 0;

    return {
      pass: passed,
      message: () =>
        passed
          ? `Expected run not to satisfy eval ${task.id}.`
          : [
              `Expected run to satisfy eval ${task.id}.`,
              ...failures.map(
                (grade) => `- ${grade.grader}: ${grade.rationale}`
              ),
            ].join('\n'),
    };
  },
};

declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- must match Vitest's own declaration
  interface Assertion<T = any> {
    toSatisfyEval(task: EvalTask): T;
  }

  interface AsymmetricMatchersContaining {
    toSatisfyEval(task: EvalTask): unknown;
  }
}
