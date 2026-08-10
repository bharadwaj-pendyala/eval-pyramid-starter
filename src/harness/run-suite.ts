import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gradeDeterministically } from '../graders/deterministic.js';
import { gradeWithJudge } from '../graders/model-judge.js';
import type {
  AgentRun,
  EvalSummary,
  EvalTask,
  Grade,
  JudgeProvider,
  ReleaseThresholds,
  SystemUnderTestFactory,
  TrialRecord,
} from '../types.js';
import { computeReliabilitySummary } from './metrics.js';
import { writeReports } from './write-reports.js';

export interface RunSuiteOptions {
  tasks: EvalTask[];
  factory: SystemUnderTestFactory;
  trials: number;
  k: number;
  concurrency: number;
  thresholds: ReleaseThresholds;
  reportDirectory: string;
  judgeProvider?: JudgeProvider;
  runId?: string;
}

export interface RunSuiteResult {
  records: TrialRecord[];
  summary: EvalSummary;
}

export async function runSuite(
  options: RunSuiteOptions
): Promise<RunSuiteResult> {
  validateOptions(options);
  const runId = options.runId ?? createRunId();
  const jobs = options.tasks.flatMap((task) =>
    Array.from({ length: options.trials }, (_, trialIndex) => ({
      task,
      trialIndex,
    }))
  );
  const records = await mapWithConcurrency(
    jobs,
    options.concurrency,
    async (job) =>
      runTrial(
        job.task,
        job.trialIndex,
        runId,
        options.factory,
        options.judgeProvider
      )
  );
  records.sort(
    (left, right) =>
      left.taskId.localeCompare(right.taskId) ||
      left.trialIndex - right.trialIndex
  );

  const summary = computeReliabilitySummary(
    records,
    options.k,
    runId,
    options.thresholds
  );
  await writeReports(options.reportDirectory, summary, records);
  return { records, summary };
}

async function runTrial(
  task: EvalTask,
  trialIndex: number,
  runId: string,
  factory: SystemUnderTestFactory,
  judgeProvider: JudgeProvider | undefined
): Promise<TrialRecord> {
  const workspace = await mkdtemp(join(tmpdir(), 'eval-pyramid-trial-'));
  const system = await factory.create();

  try {
    const run = await system.run(task, { runId, trialIndex, workspace });
    const deterministicGrades = gradeDeterministically(task, run);
    const judgeGrades = judgeProvider
      ? await gradeWithJudge(task, run, judgeProvider)
      : [];
    const grades = [...deterministicGrades, ...judgeGrades];
    const deterministicPassed = deterministicGrades.every(
      (grade) => grade.passed
    );
    const judgePassed =
      judgeGrades.length > 0
        ? judgeGrades.every((grade) => grade.passed)
        : null;
    return {
      taskId: task.id,
      trialIndex,
      run,
      grades,
      error: null,
      deterministicPassed,
      judgePassed,
      passed: deterministicPassed && judgePassed !== false,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown system-under-test error';
    const grade: Grade = {
      grader: 'runtime',
      score: 0,
      passed: false,
      rationale: message,
    };
    return {
      taskId: task.id,
      trialIndex,
      run: failedRun(),
      grades: [grade],
      error: message,
      deterministicPassed: false,
      judgePassed: judgeProvider ? false : null,
      passed: false,
    };
  } finally {
    await system.dispose?.();
    await rm(workspace, { recursive: true, force: true });
  }
}

function failedRun(): AgentRun {
  return {
    output: null,
    outcome: {},
    transcript: [],
    toolCalls: [],
    metrics: {
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      turns: 0,
    },
  };
}

function validateOptions(options: RunSuiteOptions): void {
  if (options.tasks.length === 0)
    throw new Error('At least one task is required.');
  if (!Number.isInteger(options.trials) || options.trials < 1)
    throw new Error('trials must be a positive integer.');
  if (
    !Number.isInteger(options.k) ||
    options.k < 1 ||
    options.k > options.trials
  ) {
    throw new Error('k must be a positive integer no greater than trials.');
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error('concurrency must be a positive integer.');
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let nextIndex = 0;

  async function consume(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => consume()
  );
  await Promise.all(workers);
  return results;
}

function createRunId(): string {
  return new Date().toISOString().replace(/[:.]/gu, '-');
}
