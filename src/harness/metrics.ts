import type {
  EvalSummary,
  Provenance,
  ReleaseCheck,
  ReleaseGate,
  ReleaseThresholds,
  TaskReliability,
  TrialRecord,
} from '../types.js';

export const SUMMARY_SCHEMA_VERSION = 2;

export function passAtK(successes: number, trials: number, k: number): number {
  validateCounts(successes, trials, k);
  return 1 - combination(trials - successes, k) / combination(trials, k);
}

export function passPowerK(
  successes: number,
  trials: number,
  k: number
): number {
  validateCounts(successes, trials, k);
  return combination(successes, k) / combination(trials, k);
}

export function computeReliabilitySummary(
  records: TrialRecord[],
  k: number,
  runId: string,
  thresholds: ReleaseThresholds,
  provenance: Provenance | null = null
): EvalSummary {
  if (records.length === 0)
    throw new Error('Cannot summarize an empty eval run.');

  const grouped = new Map<string, TrialRecord[]>();
  for (const record of records) {
    const group = grouped.get(record.taskId) ?? [];
    group.push(record);
    grouped.set(record.taskId, group);
  }

  const tasks: TaskReliability[] = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([taskId, taskRecords]) => taskReliability(taskId, taskRecords, k));

  // Only trials that reached a verdict describe the system under test. An
  // invalid trial measured nothing, so it cannot raise or lower a rate.
  const scored = records.filter((record) => record.outcome.scored);
  const invalidTrialCount = records.length - scored.length;
  const invalidRate = invalidTrialCount / records.length;

  // The deterministic layer can succeed on a trial the judge later lost, so
  // its rate covers every trial where it actually ran.
  const deterministicMeasured = records.filter(
    (record) => record.deterministicPassed !== null
  );
  const deterministicPassRate =
    deterministicMeasured.length > 0
      ? deterministicMeasured.filter((record) => record.deterministicPassed)
          .length / deterministicMeasured.length
      : null;
  const judgeGrades = scored.flatMap((record) =>
    record.grades.filter((grade) => grade.grader.startsWith('judge:'))
  );
  const judgeAverage =
    judgeGrades.length > 0
      ? average(judgeGrades.map((grade) => grade.score))
      : null;
  const passAt1Average = averageOf(tasks.map((task) => task.passAt1));
  const passAtKAverage = averageOf(tasks.map((task) => task.passAtK));
  const passPowerKAverage = averageOf(tasks.map((task) => task.passPowerK));

  return {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    runId,
    generatedAt: new Date().toISOString(),
    k,
    taskCount: tasks.length,
    trialCount: records.length,
    scoredTrialCount: scored.length,
    invalidTrialCount,
    invalidRate,
    deterministicPassRate,
    judgeAverage,
    passAt1: passAt1Average,
    passAtK: passAtKAverage,
    passPowerK: passPowerKAverage,
    totalCostUsd: scored.reduce(
      (total, record) => total + record.run.metrics.costUsd,
      0
    ),
    medianTrialDurationMs: median(
      scored
        .filter((record) => record.durationMs !== null)
        .map((record) => record.durationMs ?? 0)
    ),
    tasks,
    releaseGate: buildReleaseGate(
      {
        deterministicPassRate,
        passAt1: passAt1Average,
        passPowerK: passPowerKAverage,
        judgeAverage,
        invalidRate,
      },
      thresholds
    ),
    provenance,
  };
}

function taskReliability(
  taskId: string,
  taskRecords: TrialRecord[],
  k: number
): TaskReliability {
  const trials = taskRecords.length;
  if (k > trials)
    throw new Error(`k=${k} exceeds ${trials} trials for task ${taskId}.`);

  const scoredRecords = taskRecords.filter((record) => record.outcome.scored);
  const scoredTrials = scoredRecords.length;
  const successes = scoredRecords.filter((record) => record.passed).length;

  return {
    taskId,
    successes,
    trials,
    scoredTrials,
    invalidTrials: trials - scoredTrials,
    // Spend and duration describe the trials that ran; a trial that measured
    // nothing must not pull either figure toward zero.
    meanCostUsd: averageOf(
      scoredRecords.map((record) => record.run.metrics.costUsd)
    ),
    medianDurationMs: median(
      scoredRecords
        .filter((record) => record.durationMs !== null)
        .map((record) => record.durationMs ?? 0)
    ),
    passAt1: scoredTrials > 0 ? successes / scoredTrials : null,
    // A sample smaller than k cannot answer a k-attempt question. Reporting
    // nothing is honest; reporting zero would read as a failure.
    passAtK: scoredTrials >= k ? passAtK(successes, scoredTrials, k) : null,
    passPowerK:
      scoredTrials >= k ? passPowerK(successes, scoredTrials, k) : null,
  };
}

interface GateInputs {
  deterministicPassRate: number | null;
  passAt1: number | null;
  passPowerK: number | null;
  judgeAverage: number | null;
  invalidRate: number;
}

function buildReleaseGate(
  actuals: GateInputs,
  thresholds: ReleaseThresholds
): ReleaseGate {
  const checks: ReleaseCheck[] = [
    minimumCheck(
      'deterministic pass rate',
      actuals.deterministicPassRate,
      thresholds.deterministicPassRate
    ),
    minimumCheck('pass@1', actuals.passAt1, thresholds.passAt1),
    minimumCheck('pass^k', actuals.passPowerK, thresholds.passPowerK),
    // A run that mostly failed to measure anything must not ship as a pass.
    maximumCheck(
      'invalid trial rate',
      actuals.invalidRate,
      thresholds.maxInvalidRate
    ),
  ];
  if (actuals.judgeAverage !== null) {
    checks.push(
      minimumCheck(
        'judge average',
        actuals.judgeAverage,
        thresholds.judgeAverage
      )
    );
  }
  return { passed: checks.every((check) => check.passed), checks };
}

function minimumCheck(
  name: string,
  actual: number | null,
  required: number
): ReleaseCheck {
  return {
    name,
    actual,
    required,
    mode: 'minimum',
    passed: actual !== null && actual >= required,
  };
}

function maximumCheck(
  name: string,
  actual: number | null,
  required: number
): ReleaseCheck {
  return {
    name,
    actual,
    required,
    mode: 'maximum',
    passed: actual !== null && actual <= required,
  };
}

function combination(n: number, k: number): number {
  if (k < 0 || n < k) return 0;
  if (k === 0 || n === k) return 1;
  const smallerK = Math.min(k, n - k);
  let value = 1;
  for (let index = 1; index <= smallerK; index += 1) {
    value = (value * (n - smallerK + index)) / index;
  }
  return value;
}

function validateCounts(successes: number, trials: number, k: number): void {
  if (
    !Number.isInteger(successes) ||
    !Number.isInteger(trials) ||
    !Number.isInteger(k)
  ) {
    throw new Error('successes, trials, and k must be integers.');
  }
  if (
    trials < 1 ||
    successes < 0 ||
    successes > trials ||
    k < 1 ||
    k > trials
  ) {
    throw new Error(
      `Invalid reliability counts: successes=${successes}, trials=${trials}, k=${k}.`
    );
  }
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Averages what was measured; tasks that measured nothing are left out. */
function averageOf(values: Array<number | null>): number | null {
  const measured = values.filter((value): value is number => value !== null);
  return measured.length > 0 ? average(measured) : null;
}

/** Duration is skewed by a few slow trials, so the middle beats the mean. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}
