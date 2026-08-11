import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import config from '../eval.config.js';
import { OpenAIJudgeProvider } from './adapters/openai-judge.js';
import {
  RefundAgentFactory,
  RemoteEnvironmentFactory,
} from './examples/refund-agent/environment.js';
import { calibrateJudge } from './harness/calibrate-judge.js';
import { runSuite } from './harness/run-suite.js';
import { loadTasks } from './loaders/tasks.js';
import {
  adjudicateReview,
  exportReviewDecisions,
  reviewQueueStatus,
  summarizeReviewQueue,
} from './reporting/review-queue.js';
import type {
  CalibrationSummary,
  EvalSummary,
  JudgeProvider,
  RunProvenance,
  SystemUnderTestFactory,
} from './types.js';

const execFileAsync = promisify(execFile);
const goldenSetFile = 'evals/judge-golden-set.jsonl';

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
    await reviewCommand(args);
    return;
  }

  printHelp();
  if (command !== 'help') process.exitCode = 1;
}

async function runCommand(args: string[]): Promise<void> {
  const trials = positiveIntegerFlag(args, '--trials', 1);
  const k = positiveIntegerFlag(args, '--k', Math.min(3, trials));
  const judgeMode = stringFlag(args, '--judge', 'none');
  const sutMode = stringFlag(args, '--sut', 'example');
  const judgeProvider = createJudge(judgeMode);
  if (judgeProvider) await requireCurrentCalibration(judgeProvider);
  const factory = createSystemFactory(sutMode);
  const tasks = await loadTasks(config.taskFile);
  const thresholds = judgeProvider ? config.liveThresholds : config.thresholds;
  const provenance = await buildProvenance(
    factory,
    judgeProvider,
    trials,
    k,
    sutMode
  );

  const { summary, latestDirectory } = await runSuite({
    tasks,
    factory,
    trials,
    k,
    concurrency: config.concurrency,
    thresholds,
    reportRoot: config.reportRoot,
    provenance,
    ...(judgeProvider ? { judgeProvider } : {}),
  });
  printSummary(summary, latestDirectory);

  if (args.includes('--fail-on-gate') && !summary.releaseGate.passed) {
    process.exitCode = 1;
  }
}

async function calibrateCommand(args: string[]): Promise<void> {
  const judgeMode = stringFlag(args, '--judge', 'openai');
  const provider = createJudge(judgeMode);
  if (!provider) throw new Error('Calibration requires --judge openai.');
  const summary = await calibrateJudge(provider, goldenSetFile);
  const file = calibrationFile(provider.name);
  await mkdir(join(config.reportRoot, 'calibration'), { recursive: true });
  await writeFile(file, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Calibration record: ${file}`);
  if (!summary.passed) process.exitCode = 1;
}

async function reviewCommand(args: string[]): Promise<void> {
  const [subcommand = 'list'] = args;
  if (subcommand === 'list') {
    console.log(await summarizeReviewQueue(config.reportRoot));
    const status = await reviewQueueStatus(config.reportRoot);
    for (const entry of status.pending) {
      console.log(
        `  ${entry.taskId} trial ${entry.trialIndex}: ${entry.reasons.join('; ')}`
      );
    }
    return;
  }
  if (subcommand === 'adjudicate') {
    const taskId = requiredFlag(args, '--task');
    const trialIndex = nonNegativeIntegerFlag(args, '--trial', -1);
    const score = numericFlag(args, '--score');
    const notes = requiredFlag(args, '--notes');
    const decision = await adjudicateReview(
      config.reportRoot,
      taskId,
      trialIndex,
      score,
      notes
    );
    console.log(JSON.stringify(decision, null, 2));
    return;
  }
  if (subcommand === 'export') {
    console.log(
      `Review export: ${await exportReviewDecisions(config.reportRoot)}`
    );
    return;
  }
  throw new Error('Review subcommand must be list, adjudicate, or export.');
}

function createJudge(mode: string): JudgeProvider | undefined {
  if (mode === 'none') return undefined;
  if (mode === 'openai') {
    const apiKey = process.env['OPENAI_API_KEY'] ?? '';
    const model = process.env['OPENAI_JUDGE_MODEL'] ?? 'gpt-5-mini';
    return new OpenAIJudgeProvider({ apiKey, model });
  }
  throw new Error(`Unsupported judge mode: ${mode}. Use none or openai.`);
}

function createSystemFactory(mode: string): SystemUnderTestFactory {
  if (mode === 'example') return new RefundAgentFactory();
  if (mode === 'http') {
    const systemRunUrl = process.env['EVAL_SUT_RUN_URL'] ?? '';
    const evidenceUrl = process.env['EVAL_EVIDENCE_URL'] ?? '';
    if (!systemRunUrl || !evidenceUrl) {
      throw new Error(
        'The HTTP SUT requires EVAL_SUT_RUN_URL and EVAL_EVIDENCE_URL.'
      );
    }
    return new RemoteEnvironmentFactory({ systemRunUrl, evidenceUrl });
  }
  throw new Error(`Unsupported SUT mode: ${mode}. Use example or http.`);
}

async function requireCurrentCalibration(
  provider: JudgeProvider
): Promise<void> {
  const file = calibrationFile(provider.name);
  let summary: CalibrationSummary;
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!isCalibrationSummary(value)) {
      throw new Error('Calibration record has an invalid schema.');
    }
    summary = value;
  } catch {
    throw new Error(
      `No calibration record exists for ${provider.name}. Run npm run eval:judge first.`
    );
  }
  const currentHash = createHash('sha256')
    .update(await readFile(goldenSetFile))
    .digest('hex');
  const ageMs = Date.now() - Date.parse(summary.calibratedAt);
  const maximumAgeMs = 7 * 24 * 60 * 60 * 1000;
  if (
    !summary.passed ||
    summary.provider !== provider.name ||
    summary.goldenSetSha256 !== currentHash ||
    !Number.isFinite(ageMs) ||
    ageMs < 0 ||
    ageMs > maximumAgeMs
  ) {
    throw new Error(
      `Calibration for ${provider.name} is failed, stale, or does not match the current golden set. Run npm run eval:judge.`
    );
  }
}

function isCalibrationSummary(value: unknown): value is CalibrationSummary {
  if (!isRecord(value)) return false;
  return (
    typeof value['provider'] === 'string' &&
    isNonNegativeNumber(value['examples']) &&
    isNonNegativeNumber(value['meanAbsoluteError']) &&
    isNonNegativeNumber(value['agreementWithinTolerance']) &&
    isNonNegativeNumber(value['tolerance']) &&
    typeof value['goldenSetFile'] === 'string' &&
    typeof value['goldenSetSha256'] === 'string' &&
    typeof value['calibratedAt'] === 'string' &&
    typeof value['passed'] === 'boolean'
  );
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function buildProvenance(
  factory: SystemUnderTestFactory,
  judge: JudgeProvider | undefined,
  trials: number,
  k: number,
  sutMode: string
): Promise<RunProvenance> {
  const taskContents = await readFile(config.taskFile);
  const thresholds = judge ? config.liveThresholds : config.thresholds;
  return {
    systemUnderTest: factory.name,
    evidenceObserver: factory.evidenceSource,
    judge: judge?.name ?? null,
    taskFile: config.taskFile,
    taskSetSha256: createHash('sha256').update(taskContents).digest('hex'),
    sourceRevision: await sourceRevision(),
    configuration: {
      trials,
      k,
      concurrency: config.concurrency,
      sutMode,
      judgeRequired: Boolean(judge),
      thresholds: {
        deterministicPassRate: thresholds.deterministicPassRate,
        passAt1: thresholds.passAt1,
        passPowerK: thresholds.passPowerK,
        judgeAverage: thresholds.judgeAverage,
        criticalPassRate: thresholds.criticalPassRate,
        requireJudge: thresholds.requireJudge,
        requireIndependentEvidence: thresholds.requireIndependentEvidence,
      },
    },
  };
}

async function sourceRevision(): Promise<string | null> {
  if (process.env['GITHUB_SHA']) return process.env['GITHUB_SHA'];
  try {
    const result = await execFileAsync('git', ['rev-parse', 'HEAD']);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

function calibrationFile(providerName: string): string {
  const safeName = providerName.replace(/[^a-zA-Z0-9._-]+/gu, '_');
  return join(config.reportRoot, 'calibration', `${safeName}.json`);
}

function stringFlag(args: string[], name: string, fallback: string): string {
  const index = args.lastIndexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--'))
    throw new Error(`${name} requires a value.`);
  return value;
}

function requiredFlag(args: string[], name: string): string {
  const value = stringFlag(args, name, '');
  if (!value) throw new Error(`${name} is required.`);
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

function numericFlag(args: string[], name: string): number {
  const value = Number(requiredFlag(args, name));
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number.`);
  return value;
}

function printSummary(summary: EvalSummary, latestDirectory: string): void {
  console.log(`Run: ${summary.runId}`);
  console.log(`Tasks: ${summary.taskCount}, trials: ${summary.trialCount}`);
  console.log(`Deterministic: ${percent(summary.deterministicPassRate)}`);
  console.log(
    `Independent evidence: ${percent(summary.independentEvidenceRate)}`
  );
  console.log(`pass@1: ${percent(summary.passAt1)}`);
  if (summary.k > 1)
    console.log(`pass@${summary.k}: ${percent(summary.passAtK)}`);
  console.log(`pass^${summary.k}: ${percent(summary.passPowerK)}`);
  console.log(
    `Judge: ${summary.judgeAverage === null ? 'not run' : percent(summary.judgeAverage)}`
  );
  console.log(`Release gate: ${summary.releaseGate.passed ? 'PASS' : 'FAIL'}`);
  console.log(`Report: ${latestDirectory}/index.html`);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function printHelp(): void {
  console.log(`Usage:
  npm run eval:deterministic
  npm run eval:repeat -- --trials 10 --k 3
  npm run eval:judge
  npm run eval:live
  npm run eval:review -- list
  npm run eval:review -- adjudicate --task TASK --trial N --score 0..1 --notes TEXT
  npm run eval:review -- export

Direct CLI:
  tsx src/cli.ts run [--sut example|http] [--trials N] [--k N]
                      [--judge none|openai] [--fail-on-gate]
  tsx src/cli.ts calibrate [--judge openai]
  tsx src/cli.ts review [list|adjudicate|export]`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown failure';
  console.error(`Eval command failed: ${message}`);
  process.exitCode = 1;
});
