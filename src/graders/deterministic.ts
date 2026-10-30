import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';

import type {
  AgentRun,
  EvalTask,
  Grade,
  JsonValue,
  ToolCall,
  ToolExpectation,
} from '../types.js';

const schemaCompiler = new Ajv2020({
  allErrors: true,
  strict: true,
  // Tasks may carry equal copies of one schema, so never register by `$id`.
  addUsedSchema: false,
});
const schemaValidators = new WeakMap<object, ValidateFunction>();

export function gradeDeterministically(task: EvalTask, run: AgentRun): Grade[] {
  const grades: Grade[] = [];

  if (task.expected.outputSchema) {
    grades.push(gradeSchema(task.expected.outputSchema, run.output));
  }
  if (task.expected.outcome) {
    grades.push(
      binaryGrade(
        'outcome',
        deepSubset(run.outcome, task.expected.outcome),
        'Final state matches the expected outcome.',
        'Final state does not match the expected outcome.'
      )
    );
  }
  if (task.expected.requiredTools || task.expected.forbiddenTools) {
    grades.push(
      gradeTools(
        run.toolCalls,
        run.rejectedToolCalls ?? [],
        task.expected.requiredTools ?? [],
        task.expected.forbiddenTools ?? []
      )
    );
  }
  if (task.expected.maxTurns !== undefined) {
    grades.push(
      limitGrade(
        'turn-budget',
        run.metrics.turns,
        task.expected.maxTurns,
        'turns'
      )
    );
  }
  if (task.expected.maxCostUsd !== undefined) {
    grades.push(usageLimitGrade(run.metrics.costUsd, task.expected.maxCostUsd));
  }
  if (task.expected.maxLatencyMs !== undefined) {
    grades.push(
      limitGrade(
        'latency-budget',
        run.metrics.latencyMs,
        task.expected.maxLatencyMs,
        'ms'
      )
    );
  }

  return grades;
}

function usageLimitGrade(actual: number | null, limit: number): Grade {
  if (actual === null) {
    return {
      grader: 'cost-budget',
      score: 0,
      passed: false,
      rationale:
        'Cost usage was not reported by the provider, so the budget cannot be verified.',
    };
  }
  return limitGrade('cost-budget', actual, limit, 'USD');
}

function gradeSchema(
  schema: { [key: string]: JsonValue },
  output: JsonValue
): Grade {
  const validate = validatorFor(schema);
  const passed = validate(output);
  const errors = validate.errors
    ?.map(
      (item) => `${item.instancePath || '/'} ${item.message ?? 'is invalid'}`
    )
    .join('; ');
  return binaryGrade(
    'output-schema',
    passed,
    'Output matches its JSON Schema.',
    errors ?? 'Output does not match its JSON Schema.'
  );
}

function validatorFor(schema: { [key: string]: JsonValue }): ValidateFunction {
  const cached = schemaValidators.get(schema);
  if (cached) return cached;
  const validate = schemaCompiler.compile(schema);
  schemaValidators.set(schema, validate);
  return validate;
}

function gradeTools(
  calls: ToolCall[],
  rejectedCalls: ToolCall[],
  required: ToolExpectation[],
  forbidden: string[]
): Grade {
  const { unmatched, early } = checkOrder(calls, required);
  const forbiddenCalls = calls.filter((call) => forbidden.includes(call.name));
  const forbiddenAttempts = rejectedCalls.filter((call) =>
    forbidden.includes(call.name)
  );
  const problems = [
    ...early.map((item) => `${item.name} called before its prerequisites`),
    ...unmatched.map((item) => `${item.name} missing or out of order`),
    ...forbiddenCalls.map((item) => `${item.name} forbidden`),
    ...forbiddenAttempts.map((item) => `${item.name} forbidden (attempted)`),
  ];
  const passed = problems.length === 0;

  return binaryGrade(
    'tool-policy',
    passed,
    'Required tools were called in order and forbidden tools were avoided.',
    `Tool policy failed: ${problems.join(', ')}.`
  );
}

// A call that matches a later requirement before its predecessors ran is out of
// order even if the sequence completes afterwards. Repeats of satisfied steps are retries.
function checkOrder(
  calls: ToolCall[],
  required: ToolExpectation[]
): { unmatched: ToolExpectation[]; early: ToolCall[] } {
  let matched = 0;
  const early: ToolCall[] = [];
  for (const call of calls) {
    const next = required[matched];
    if (next && toolMatches(call, next)) {
      matched += 1;
    } else if (
      required.slice(matched + 1).some((step) => toolMatches(call, step))
    ) {
      early.push(call);
    }
  }
  return { unmatched: required.slice(matched), early };
}

function toolMatches(call: ToolCall, expected: ToolExpectation): boolean {
  return (
    call.name === expected.name &&
    (expected.arguments === undefined ||
      deepSubset(call.arguments, expected.arguments))
  );
}

function limitGrade(
  grader: string,
  actual: number,
  limit: number,
  unit: string
): Grade {
  const passed = actual <= limit;
  return {
    grader,
    score: passed ? 1 : 0,
    passed,
    rationale: `${actual} ${unit} used; limit is ${limit} ${unit}.`,
  };
}

function binaryGrade(
  grader: string,
  passed: boolean,
  success: string,
  failure: string
): Grade {
  return {
    grader,
    score: passed ? 1 : 0,
    passed,
    rationale: passed ? success : failure,
  };
}

export function deepSubset(actual: JsonValue, expected: JsonValue): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length)
      return false;
    return expected.every((item, index) => {
      const actualItem = actual[index];
      return actualItem !== undefined && deepSubset(actualItem, item);
    });
  }

  if (typeof expected === 'object' && expected !== null) {
    if (typeof actual !== 'object' || actual === null || Array.isArray(actual))
      return false;
    return Object.entries(expected).every(([key, value]) => {
      const actualValue = actual[key];
      return actualValue !== undefined && deepSubset(actualValue, value);
    });
  }

  return Object.is(actual, expected);
}
