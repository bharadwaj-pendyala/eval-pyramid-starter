import { randomUUID } from 'node:crypto';
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
  ObservedEvidence,
  ReleaseThresholds,
  RunProvenance,
  SystemRun,
  SystemUnderTestFactory,
  TrialContext,
  TrialEnvironment,
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
  reportRoot: string;
  judgeProvider?: JudgeProvider;
  provenance?: RunProvenance;
  runId?: string;
}

export interface RunSuiteResult {
  records: TrialRecord[];
  summary: EvalSummary;
  runDirectory: string;
  latestDirectory: string;
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

  const provenance =
    options.provenance ?? fallbackProvenance(options, options.factory);
  const summary = computeReliabilitySummary(
    records,
    options.k,
    runId,
    options.thresholds,
    provenance
  );
  const locations = await writeReports(options.reportRoot, summary, records);
  return { records, summary, ...locations };
}

async function runTrial(
  task: EvalTask,
  trialIndex: number,
  runId: string,
  factory: SystemUnderTestFactory,
  judgeProvider: JudgeProvider | undefined
): Promise<TrialRecord> {
  let workspace: string | undefined;
  let environment: TrialEnvironment | undefined;
  let record: TrialRecord;

  try {
    workspace = await mkdtemp(join(tmpdir(), 'eval-pyramid-trial-'));
    const context: TrialContext = {
      runId,
      trialId: randomUUID(),
      trialIndex,
      workspace,
    };
    environment = await factory.create(context);
    record = await executeTrial(task, context, environment, judgeProvider);
  } catch (error) {
    record = failedTrial(
      task,
      trialIndex,
      errorMessage(error, 'Unknown system-under-test error'),
      judgeProvider !== undefined
    );
  }

  const cleanupErrors = await cleanupTrial(environment, workspace);
  return cleanupErrors.length > 0
    ? appendOperationalFailure(record, 'cleanup', cleanupErrors.join('; '))
    : record;
}

async function executeTrial(
  task: EvalTask,
  context: TrialContext,
  environment: TrialEnvironment,
  judgeProvider: JudgeProvider | undefined
): Promise<TrialRecord> {
  const startedAt = performance.now();
  const systemRun = await environment.system.run(
    structuredClone(task.input),
    context
  );
  const latencyMs = Math.max(0, performance.now() - startedAt);

  let evidence: ObservedEvidence;
  try {
    evidence = await environment.observer.observe(task, context);
  } catch (error) {
    const message = errorMessage(error, 'Unknown evidence observer error');
    return evidenceFailureRecord(
      task,
      context.trialIndex,
      measuredRun(systemRun, latencyMs, {
        outcome: {},
        toolCalls: [],
        source: 'unavailable',
      }),
      message,
      judgeProvider !== undefined
    );
  }

  const run = measuredRun(systemRun, latencyMs, evidence);
  let deterministicGrades: Grade[];
  try {
    deterministicGrades = gradeDeterministically(task, run);
  } catch (error) {
    const message = errorMessage(error, 'Unknown deterministic grader error');
    return {
      taskId: task.id,
      severity: task.severity,
      trialIndex: context.trialIndex,
      run,
      grades: [runtimeGrade('deterministic:runtime', message)],
      error: message,
      deterministicPassed: false,
      judgePassed: judgeProvider ? false : null,
      passed: false,
    };
  }

  let judgeGrades: Grade[] = [];
  let judgeError: string | null = null;
  if (judgeProvider) {
    try {
      judgeGrades = await gradeWithJudge(task, run, judgeProvider);
    } catch (error) {
      judgeError = errorMessage(error, 'Unknown judge error');
      judgeGrades = judgeRuntimeGrades(task, judgeError);
    }
  }

  const grades = [...deterministicGrades, ...judgeGrades];
  const deterministicPassed = deterministicGrades.every(
    (grade) => grade.passed
  );
  const judgePassed =
    judgeGrades.length > 0 ? judgeGrades.every((grade) => grade.passed) : null;
  return {
    taskId: task.id,
    severity: task.severity,
    trialIndex: context.trialIndex,
    run,
    grades,
    error: judgeError,
    deterministicPassed,
    judgePassed,
    passed: deterministicPassed && judgePassed !== false,
  };
}

function measuredRun(
  systemRun: SystemRun,
  latencyMs: number,
  evidence: ObservedEvidence
): AgentRun {
  return {
    output: systemRun.output,
    outcome: evidence.outcome,
    transcript: systemRun.transcript,
    toolCalls: evidence.toolCalls,
    rejectedToolCalls: evidence.rejectedToolCalls ?? [],
    evidenceSource: evidence.source,
    metrics: {
      latencyMs: Math.round(latencyMs * 100) / 100,
      inputTokens: systemRun.metrics.inputTokens ?? null,
      outputTokens: systemRun.metrics.outputTokens ?? null,
      costUsd: systemRun.metrics.costUsd ?? null,
      turns: systemRun.metrics.turns,
      latencySource: 'harness-wall-clock',
      usageSource: systemRun.metrics.usageSource ?? null,
    },
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
  environment: TrialEnvironment | undefined,
  workspace: string | undefined
): Promise<string[]> {
  const errors: string[] = [];
  try {
    await environment?.dispose?.();
  } catch (error) {
    errors.push(
      `Environment disposal failed: ${errorMessage(error, 'unknown error')}`
    );
  }

  if (workspace) {
    try {
      await rm(workspace, { recursive: true, force: true });
    } catch (error) {
      errors.push(
        `Workspace cleanup failed: ${errorMessage(error, 'unknown error')}`
      );
    }
  }
  return errors;
}

function failedTrial(
  task: EvalTask,
  trialIndex: number,
  message: string,
  judgeEnabled: boolean
): TrialRecord {
  return {
    taskId: task.id,
    severity: task.severity,
    trialIndex,
    run: failedRun(),
    grades: [runtimeGrade('runtime', message)],
    error: message,
    deterministicPassed: false,
    judgePassed: judgeEnabled ? false : null,
    passed: false,
  };
}

function evidenceFailureRecord(
  task: EvalTask,
  trialIndex: number,
  run: AgentRun,
  message: string,
  judgeEnabled: boolean
): TrialRecord {
  return {
    taskId: task.id,
    severity: task.severity,
    trialIndex,
    run,
    grades: [runtimeGrade('evidence:runtime', message)],
    error: message,
    deterministicPassed: false,
    judgePassed: judgeEnabled ? false : null,
    passed: false,
  };
}

function appendOperationalFailure(
  record: TrialRecord,
  grader: string,
  message: string
): TrialRecord {
  return {
    ...record,
    grades: [...record.grades, runtimeGrade(grader, message)],
    error: record.error ? `${record.error}; ${message}` : message,
    deterministicPassed: false,
    judgePassed: record.judgePassed === null ? null : false,
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
    evidenceSource: 'unavailable',
    metrics: {
      latencyMs: 0,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      turns: 0,
      latencySource: 'harness-wall-clock',
      usageSource: null,
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

function fallbackProvenance(
  options: RunSuiteOptions,
  factory: SystemUnderTestFactory
): RunProvenance {
  return {
    systemUnderTest: factory.name,
    evidenceObserver: factory.evidenceSource,
    judge: options.judgeProvider?.name ?? null,
    taskFile: 'not-provided',
    taskSetSha256: 'not-provided',
    sourceRevision: null,
    configuration: {
      trials: options.trials,
      k: options.k,
      concurrency: options.concurrency,
    },
  };
}

function createRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}-${randomUUID().slice(0, 8)}`;
}
