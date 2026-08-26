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
  SystemUnderTest,
  SystemUnderTestFactory,
  TrialRecord,
  TrialStatus,
} from '../types.js';
import { computeReliabilitySummary } from './metrics.js';
import { completed, invalid } from './outcomes.js';
import { computeProvenance } from './provenance.js';
import { writeReports } from './write-reports.js';

/**
 * Failures worth another attempt: they come from the infrastructure, not from
 * the task. A grader bug is deterministic, so retrying it only wastes budget,
 * and a real result is never retried - that would bias the sample.
 */
const RETRYABLE_STATUSES = new Set<TrialStatus>([
  'harness_error',
  'judge_error',
  'system_error',
]);

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
  /** Extra attempts for a trial lost to an infrastructure failure. Defaults to none. */
  retries?: number;
  /** Recorded in the report so a result names the system it measured. */
  systemLabel?: string;
  taskFile?: string;
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
  const retries = options.retries ?? 0;
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
        options.judgeProvider,
        retries
      )
  );
  records.sort(
    (left, right) =>
      left.taskId.localeCompare(right.taskId) ||
      left.trialIndex - right.trialIndex
  );

  const provenance = await computeProvenance({
    tasks: options.tasks,
    thresholds: options.thresholds,
    trials: options.trials,
    k: options.k,
    concurrency: options.concurrency,
    retries,
    systemUnderTest: options.systemLabel ?? options.factory.constructor.name,
    judge: options.judgeProvider?.name,
    taskFile: options.taskFile,
  });

  const summary = computeReliabilitySummary(
    records,
    options.k,
    runId,
    options.thresholds,
    provenance
  );
  await writeReports(options.reportDirectory, summary, records);
  return { records, summary };
}

async function runTrial(
  task: EvalTask,
  trialIndex: number,
  runId: string,
  factory: SystemUnderTestFactory,
  judgeProvider: JudgeProvider | undefined,
  retries: number
): Promise<TrialRecord> {
  let record = await attemptTrial(
    task,
    trialIndex,
    runId,
    factory,
    judgeProvider
  );
  const warnings = [...record.warnings];
  let attempts = 1;

  while (attempts <= retries && RETRYABLE_STATUSES.has(record.outcome.status)) {
    warnings.push(
      `Attempt ${attempts} was retried after ${record.outcome.status}: ${record.outcome.detail ?? 'no detail'}`
    );
    record = await attemptTrial(
      task,
      trialIndex,
      runId,
      factory,
      judgeProvider
    );
    warnings.push(...record.warnings);
    attempts += 1;
  }

  return { ...record, attempts, warnings };
}

async function attemptTrial(
  task: EvalTask,
  trialIndex: number,
  runId: string,
  factory: SystemUnderTestFactory,
  judgeProvider: JudgeProvider | undefined
): Promise<TrialRecord> {
  let workspace: string;
  try {
    workspace = await mkdtemp(join(tmpdir(), 'eval-pyramid-trial-'));
  } catch (error) {
    return invalidTrial(
      task,
      trialIndex,
      'harness_error',
      errorMessage(error, 'Could not create a trial workspace')
    );
  }

  let system: SystemUnderTest | undefined;
  let record: TrialRecord;
  try {
    system = await factory.create();
    record = await executeTrial(
      task,
      trialIndex,
      runId,
      workspace,
      system,
      judgeProvider
    );
  } catch (error) {
    record = invalidTrial(
      task,
      trialIndex,
      'system_error',
      errorMessage(error, 'Unknown system-under-test error')
    );
  }

  // Cleanup happens after the measurement, so its failures are operational
  // noise rather than evidence about the system under test.
  const warnings = await cleanupTrial(system, workspace);
  return warnings.length > 0 ? { ...record, warnings } : record;
}

async function executeTrial(
  task: EvalTask,
  trialIndex: number,
  runId: string,
  workspace: string,
  system: SystemUnderTest,
  judgeProvider: JudgeProvider | undefined
): Promise<TrialRecord> {
  let run: AgentRun;
  const startedAt = performance.now();
  let durationMs: number;
  try {
    run = await system.run(task, { runId, trialIndex, workspace });
    durationMs = elapsedSince(startedAt);
  } catch (error) {
    return {
      ...invalidTrial(
        task,
        trialIndex,
        'system_error',
        errorMessage(error, 'Unknown system-under-test error')
      ),
      durationMs: elapsedSince(startedAt),
    };
  }

  let deterministicGrades: Grade[];
  try {
    deterministicGrades = gradeDeterministically(task, run, { durationMs });
  } catch (error) {
    const message = errorMessage(error, 'Unknown deterministic grader error');
    return {
      ...invalidTrial(task, trialIndex, 'grader_error', message),
      run,
      durationMs,
      grades: [runtimeGrade('deterministic:runtime', message)],
    };
  }

  const deterministicPassed = deterministicGrades.every(
    (grade) => grade.passed
  );

  if (judgeProvider) {
    try {
      const judgeGrades = await gradeWithJudge(task, run, judgeProvider);
      const judgePassed =
        judgeGrades.length > 0
          ? judgeGrades.every((grade) => grade.passed)
          : null;
      return {
        taskId: task.id,
        trialIndex,
        run,
        grades: [...deterministicGrades, ...judgeGrades],
        outcome: completed(),
        attempts: 1,
        durationMs,
        warnings: [],
        error: null,
        deterministicPassed,
        judgePassed,
        passed: deterministicPassed && judgePassed !== false,
      };
    } catch (error) {
      // The deterministic layer still measured something, so its result is
      // kept; the trial as a whole reached no verdict.
      const message = errorMessage(error, 'Unknown judge error');
      return {
        ...invalidTrial(task, trialIndex, 'judge_error', message),
        run,
        durationMs,
        grades: [...deterministicGrades, ...judgeRuntimeGrades(task, message)],
        deterministicPassed,
      };
    }
  }

  return {
    taskId: task.id,
    trialIndex,
    run,
    grades: deterministicGrades,
    outcome: completed(),
    attempts: 1,
    durationMs,
    warnings: [],
    error: null,
    deterministicPassed,
    judgePassed: null,
    passed: deterministicPassed,
  };
}

function judgeRuntimeGrades(task: EvalTask, message: string): Grade[] {
  const criteria = task.rubric ?? [];
  if (criteria.length === 0) return [runtimeGrade('judge:runtime', message)];
  return criteria.map((criterion) =>
    runtimeGrade(`judge:${criterion.id}:runtime`, message)
  );
}

async function cleanupTrial(
  system: SystemUnderTest | undefined,
  workspace: string | undefined
): Promise<string[]> {
  const warnings: string[] = [];
  try {
    await system?.dispose?.();
  } catch (error) {
    warnings.push(
      `System disposal failed: ${errorMessage(error, 'unknown error')}`
    );
  }

  if (workspace) {
    try {
      await rm(workspace, { recursive: true, force: true });
    } catch (error) {
      warnings.push(
        `Workspace cleanup failed: ${errorMessage(error, 'unknown error')}`
      );
    }
  }
  return warnings;
}

function invalidTrial(
  task: EvalTask,
  trialIndex: number,
  status: TrialStatus,
  message: string
): TrialRecord {
  return {
    taskId: task.id,
    trialIndex,
    run: failedRun(),
    grades: [runtimeGrade(status, message)],
    outcome: invalid(status, message),
    attempts: 1,
    durationMs: null,
    warnings: [],
    error: message,
    deterministicPassed: null,
    judgePassed: null,
    passed: false,
  };
}

function runtimeGrade(grader: string, message: string): Grade {
  return { grader, score: 0, passed: false, rationale: message };
}

/** Tenth-of-a-millisecond resolution, so a fast adapter does not read as zero. */
function elapsedSince(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
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
  if (
    options.retries !== undefined &&
    (!Number.isInteger(options.retries) || options.retries < 0)
  ) {
    throw new Error('retries must be zero or a positive integer.');
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
