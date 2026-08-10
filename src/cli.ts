import config from '../eval.config.js';
import { FakeJudgeProvider } from './adapters/fake-judge.js';
import { FakeRefundAgentFactory } from './adapters/fake-refund-agent.js';
import { OpenAIJudgeProvider } from './adapters/openai-judge.js';
import { calibrateJudge } from './harness/calibrate-judge.js';
import { runSuite } from './harness/run-suite.js';
import { loadTasks } from './loaders/tasks.js';
import { summarizeReviewQueue } from './reporting/review-queue.js';
import type { EvalSummary, JudgeProvider } from './types.js';

async function main(): Promise<void> {
  const [command = 'help', ...args] = process.argv.slice(2);

  if (command === 'run') {
    await runCommand(args);
    return;
  }
  if (command === 'calibrate') {
    await calibrateCommand(args);
    return;
  }
  if (command === 'review') {
    console.log(await summarizeReviewQueue(config.reportDirectory));
    return;
  }

  printHelp();
  if (command !== 'help') process.exitCode = 1;
}

async function runCommand(args: string[]): Promise<void> {
  const trials = positiveIntegerFlag(args, '--trials', 1);
  const k = positiveIntegerFlag(args, '--k', Math.min(3, trials));
  const failureEvery = nonNegativeIntegerFlag(args, '--failure-every', 0);
  const judgeMode = stringFlag(args, '--judge', 'none');
  const judgeProvider = createJudge(judgeMode);
  const tasks = await loadTasks(config.taskFile);

  const runOptions = {
    tasks,
    factory: new FakeRefundAgentFactory({ failureEvery }),
    trials,
    k,
    concurrency: config.concurrency,
    thresholds: config.thresholds,
    reportDirectory: config.reportDirectory,
    ...(judgeProvider ? { judgeProvider } : {}),
  };
  const { summary } = await runSuite(runOptions);
  printSummary(summary);

  if (args.includes('--fail-on-gate') && !summary.releaseGate.passed) {
    process.exitCode = 1;
  }
}

async function calibrateCommand(args: string[]): Promise<void> {
  const judgeMode = stringFlag(args, '--judge', 'fake');
  const provider = createJudge(judgeMode);
  if (!provider)
    throw new Error('Calibration requires --judge fake or --judge openai.');
  const summary = await calibrateJudge(provider);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.passed) process.exitCode = 1;
}

function createJudge(mode: string): JudgeProvider | undefined {
  if (mode === 'none') return undefined;
  if (mode === 'fake') return new FakeJudgeProvider();
  if (mode === 'openai') {
    const apiKey = process.env['OPENAI_API_KEY'] ?? '';
    const model = process.env['OPENAI_JUDGE_MODEL'] ?? 'gpt-5-mini';
    return new OpenAIJudgeProvider({ apiKey, model });
  }
  throw new Error(
    `Unsupported judge mode: ${mode}. Use none, fake, or openai.`
  );
}

function stringFlag(args: string[], name: string, fallback: string): string {
  const index = args.lastIndexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--'))
    throw new Error(`${name} requires a value.`);
  return value;
}

function positiveIntegerFlag(
  args: string[],
  name: string,
  fallback: number
): number {
  const value = integerFlag(args, name, fallback);
  if (value < 1) throw new Error(`${name} must be at least 1.`);
  return value;
}

function nonNegativeIntegerFlag(
  args: string[],
  name: string,
  fallback: number
): number {
  const value = integerFlag(args, name, fallback);
  if (value < 0) throw new Error(`${name} must be zero or greater.`);
  return value;
}

function integerFlag(args: string[], name: string, fallback: number): number {
  const raw = stringFlag(args, name, String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
  return value;
}

function printSummary(summary: EvalSummary): void {
  console.log(`Run: ${summary.runId}`);
  console.log(`Tasks: ${summary.taskCount}, trials: ${summary.trialCount}`);
  console.log(`Deterministic: ${percent(summary.deterministicPassRate)}`);
  console.log(`pass@1: ${percent(summary.passAt1)}`);
  if (summary.k > 1)
    console.log(`pass@${summary.k}: ${percent(summary.passAtK)}`);
  console.log(`pass^${summary.k}: ${percent(summary.passPowerK)}`);
  console.log(
    `Judge: ${summary.judgeAverage === null ? 'not run' : percent(summary.judgeAverage)}`
  );
  console.log(`Release gate: ${summary.releaseGate.passed ? 'PASS' : 'FAIL'}`);
  console.log(`Report: ${config.reportDirectory}/index.html`);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function printHelp(): void {
  console.log(`Usage:
  npm run eval:deterministic
  npm run eval:repeat -- --trials 10 --k 3
  npm run eval:judge
  npm run eval:review

Direct CLI:
  tsx src/cli.ts run [--trials N] [--k N] [--judge none|fake|openai]
                       [--failure-every N] [--fail-on-gate]
  tsx src/cli.ts calibrate [--judge fake|openai]
  tsx src/cli.ts review`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown failure';
  console.error(`Eval command failed: ${message}`);
  process.exitCode = 1;
});
