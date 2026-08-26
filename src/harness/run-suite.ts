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
  TrialOutcome,
  TrialRecord,
  TrialStatus,
} from '../types.js';
import { computeReliabilitySummary } from './metrics.js';
import { completed, invalid } from './outcomes.js';
import { computeProvenance } from './provenance.js';
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

  const provenance = await computeProvenance({
    tasks: options.tasks,
    thresholds: options.thresholds,
    trials: options.trials,
    k: options.k,
    concurrency: options.concurrency,
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
  try {
    run = await system.run(task, { runId, trialIndex, workspace });
  } catch (error) {
    return invalidTrial(
      task,
      trialIndex,
      'system_error',
      errorMessage(error, 'Unknown system-under-test error')
    );
  }

  let deterministicGrades: Grade[];
  try {
    deterministicGrades = gradeDeterministically(task, run);
  } catch (error) {
    const message = errorMessage(error, 'Unknown deterministic grader error');
    return {
      ...invalidTrial(task, trialIndex, 'grader_error', message),
      run,
      grades: [runtimeGrade('deterministic:runtime', message)],
    };
  }

  const deterministicPassed = deterministicGrades.every(
    (grade) => grade.passed
  );

  if (judgeProvider) {
    try {
      const judgeGrades = await gradeWithJudge(task, run, judgeProvider);
      const grades = [...deterministicGrades, ...judgeGrades];
      const judgePassed =
        judgeGrades.length > 0
          ? judgeGrades.every((grade) => grade.passed)
          : null;
      return {
        taskId: task.id,
        trialIndex,
        run,
        grades,
        outcome: completed(),
        warnings: [],
        error: null,
        deterministicPassed,
        judgePassed,
        passed: deterministicPassed && judgePassed !== false,
      };
    } catch (error) {
      // The deterministic evidence survives, but no verdict exists for this
      // trial, so it must not count as a model failure.
      const message = errorMessage(error, 'Unknown judge error');
      return {
        ...invalidTrial(task, trialIndex, 'judge_error', message),
        run,
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
  const outcome: TrialOutcome = invalid(status, message);
  return {
    taskId: task.id,
    trialIndex,
    run: failedRun(),
    grades: [runtimeGrade(status, message)],
    outcome,
    warnings: [],
    error: message,
    deterministicPassed: false,
    judgePassed: null,
    passed: false,
  };
}

function runtimeGrade(grader: string, message: string): Grade {
  return { grader, score: 0, passed: false, rationale: message };
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
