import type {
  EvalSummary,
  ReleaseGate,
  ReleaseThresholds,
  TaskReliability,
  TrialRecord,
} from '../types.js';

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
  thresholds: ReleaseThresholds
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
    .map(([taskId, taskRecords]) => {
      const successes = taskRecords.filter((record) => record.passed).length;
      const trials = taskRecords.length;
      if (k > trials)
        throw new Error(`k=${k} exceeds ${trials} trials for task ${taskId}.`);
      return {
        taskId,
        successes,
        trials,
        passAt1: successes / trials,
        passAtK: passAtK(successes, trials, k),
        passPowerK: passPowerK(successes, trials, k),
      };
    });

  const deterministicPassRate =
    records.filter((record) => record.deterministicPassed).length /
    records.length;
  const judgeGrades = records.flatMap((record) =>
    record.grades.filter((grade) => grade.grader.startsWith('judge:'))
  );
  const judgeAverage =
    judgeGrades.length > 0
      ? average(judgeGrades.map((grade) => grade.score))
      : null;
  const passAt1Average = average(tasks.map((task) => task.passAt1));
  const passAtKAverage = average(tasks.map((task) => task.passAtK));
  const passPowerKAverage = average(tasks.map((task) => task.passPowerK));

  return {
    runId,
    generatedAt: new Date().toISOString(),
    k,
    taskCount: tasks.length,
    trialCount: records.length,
    deterministicPassRate,
    judgeAverage,
    passAt1: passAt1Average,
    passAtK: passAtKAverage,
    passPowerK: passPowerKAverage,
    tasks,
    releaseGate: buildReleaseGate(
      deterministicPassRate,
      passAt1Average,
      passPowerKAverage,
      judgeAverage,
      thresholds
    ),
  };
}

function buildReleaseGate(
  deterministicPassRate: number,
  passAt1Value: number,
  passPowerKValue: number,
  judgeAverage: number | null,
  thresholds: ReleaseThresholds
): ReleaseGate {
  const checks: ReleaseGate['checks'] = [
    thresholdCheck(
      'deterministic pass rate',
      deterministicPassRate,
      thresholds.deterministicPassRate
    ),
    thresholdCheck('pass@1', passAt1Value, thresholds.passAt1),
    thresholdCheck('pass^k', passPowerKValue, thresholds.passPowerK),
  ];
  if (judgeAverage !== null) {
    checks.push(
      thresholdCheck('judge average', judgeAverage, thresholds.judgeAverage)
    );
  }
  return { passed: checks.every((check) => check.passed), checks };
}

function thresholdCheck(
  name: string,
  actual: number,
  required: number
): ReleaseGate['checks'][number] {
  return { name, actual, required, passed: actual >= required };
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
