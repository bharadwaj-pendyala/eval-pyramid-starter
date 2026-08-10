import { readFile } from 'node:fs/promises';

import type {
  AgentRun,
  CalibrationSummary,
  EvalTask,
  GoldenJudgeExample,
  JudgeProvider,
} from '../types.js';

export async function calibrateJudge(
  provider: JudgeProvider,
  goldenSetFile = 'evals/judge-golden-set.jsonl',
  tolerance = 0.25
): Promise<CalibrationSummary> {
  const examples = await loadGoldenSet(goldenSetFile);
  const differences: number[] = [];

  for (const example of examples) {
    const task = calibrationTask(example);
    const run = calibrationRun(example.output);
    const result = await provider.score({
      task,
      run,
      criterion: example.criterion,
    });
    differences.push(Math.abs(result.score - example.humanScore));
  }

  const meanAbsoluteError = average(differences);
  const agreementWithinTolerance =
    differences.filter((difference) => difference <= tolerance).length /
    differences.length;

  return {
    provider: provider.name,
    examples: examples.length,
    meanAbsoluteError,
    agreementWithinTolerance,
    tolerance,
    passed: meanAbsoluteError <= tolerance && agreementWithinTolerance >= 0.8,
  };
}

async function loadGoldenSet(filePath: string): Promise<GoldenJudgeExample[]> {
  const contents = await readFile(filePath, 'utf8');
  const lines = contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  const examples = lines.map((line, index) => {
    const value: unknown = JSON.parse(line);
    if (!isGoldenJudgeExample(value)) {
      throw new Error(
        `Invalid judge calibration record on line ${index + 1} of ${filePath}.`
      );
    }
    return value;
  });

  if (examples.length === 0)
    throw new Error(`No judge calibration examples found in ${filePath}.`);
  return examples;
}

function isGoldenJudgeExample(value: unknown): value is GoldenJudgeExample {
  if (!isRecord(value) || !isRecord(value['criterion'])) return false;
  const criterion = value['criterion'];
  return (
    typeof value['id'] === 'string' &&
    typeof value['output'] === 'string' &&
    typeof value['humanScore'] === 'number' &&
    value['humanScore'] >= 0 &&
    value['humanScore'] <= 1 &&
    typeof criterion['id'] === 'string' &&
    typeof criterion['description'] === 'string' &&
    typeof criterion['minimumScore'] === 'number' &&
    (criterion['requiredSignals'] === undefined ||
      (Array.isArray(criterion['requiredSignals']) &&
        criterion['requiredSignals'].every((item) => typeof item === 'string')))
  );
}

function calibrationTask(example: GoldenJudgeExample): EvalTask {
  return {
    id: example.id,
    description: 'Judge calibration example with a trusted human score.',
    input: { customerId: 'calibration', message: 'Calibration input' },
    expected: { maxTurns: 1 },
    rubric: [example.criterion],
  };
}

function calibrationRun(output: string): AgentRun {
  return {
    output,
    outcome: {},
    transcript: [{ role: 'assistant', content: output }],
    toolCalls: [],
    metrics: {
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      turns: 1,
    },
  };
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
