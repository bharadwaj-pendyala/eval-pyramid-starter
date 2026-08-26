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

const schemaCompiler = new Ajv2020({ allErrors: true, strict: true });
const schemaValidators = new WeakMap<object, ValidateFunction>();

/** What the harness itself measured, which beats anything the system reports about itself. */
export interface ObservedTrial {
  durationMs?: number;
}

export function gradeDeterministically(
  task: EvalTask,
  run: AgentRun,
  observed: ObservedTrial = {}
): Grade[] {
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
    grades.push(
      limitGrade(
        'cost-budget',
        run.metrics.costUsd,
        task.expected.maxCostUsd,
        'USD'
      )
    );
  }
  if (task.expected.maxLatencyMs !== undefined) {
    // Prefer the harness's own clock; fall back to the self-report only when
    // the caller measured nothing.
    const measured = observed.durationMs !== undefined;
    grades.push(
      limitGrade(
        'latency-budget',
        measured ? (observed.durationMs ?? 0) : run.metrics.latencyMs,
        task.expected.maxLatencyMs,
        'ms',
        measured ? 'measured by the harness' : 'reported by the system'
      )
    );
  }

  return grades;
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
  required: ToolExpectation[],
  forbidden: string[]
): Grade {
  const missing = required.filter(
    (expected) => !calls.some((call) => toolMatches(call, expected))
  );
  const forbiddenCalls = calls.filter((call) => forbidden.includes(call.name));
  const passed = missing.length === 0 && forbiddenCalls.length === 0;

  const problems = [
    ...missing.map((item) => `missing ${item.name}`),
    ...forbiddenCalls.map((item) => `forbidden ${item.name}`),
  ];

  return binaryGrade(
    'tool-policy',
    passed,
    'Required tools were called and forbidden tools were avoided.',
    `Tool policy failed: ${problems.join(', ')}.`
  );
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
  unit: string,
  source = 'reported by the system'
): Grade {
  const passed = actual <= limit;
  return {
    grader,
    score: passed ? 1 : 0,
    passed,
    rationale: `${actual} ${unit} used (${source}); limit is ${limit} ${unit}.`,
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
