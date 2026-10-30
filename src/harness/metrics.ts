import type {
  EvalSummary,
  ReleaseGate,
  ReleaseThresholds,
  RunProvenance,
  TaskReliability,
  TrialRecord,
} from '../types.js';

export function passAtK(successes: number, trials: number, k: number): number {
  validateCounts(successes, trials, k);
  if (trials - successes < k) return 1;
  // Products of ratios stay finite where the binomial coefficients overflow.
  let allFail = 1;
  for (let index = trials - successes + 1; index <= trials; index += 1) {
    allFail *= 1 - k / index;
  }
  return 1 - allFail;
}

export function passPowerK(
  successes: number,
  trials: number,
  k: number
): number {
  validateCounts(successes, trials, k);
  let allPass = 1;
  for (let index = 0; index < k; index += 1) {
    allPass *= (successes - index) / (trials - index);
  }
  return Math.max(0, allPass);
}

export function computeReliabilitySummary(
  records: TrialRecord[],
  k: number,
  runId: string,
  thresholds: ReleaseThresholds,
  provenance: RunProvenance = unknownProvenance()
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
        severity: taskRecords[0]?.severity ?? 'medium',
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
  const independentEvidenceRate =
    records.filter((record) => isIndependent(record.run.evidenceSource))
      .length / records.length;
  const criticalRecords = records.filter(
    (record) => record.severity === 'critical'
  );
  const criticalPassRate =
    criticalRecords.length === 0
      ? 1
      : criticalRecords.filter((record) => record.passed).length /
        criticalRecords.length;
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
    independentEvidenceRate,
    criticalPassRate,
    passAt1: passAt1Average,
    passAtK: passAtKAverage,
    passPowerK: passPowerKAverage,
    tasks,
    releaseGate: buildReleaseGate(
      deterministicPassRate,
      passAt1Average,
      passPowerKAverage,
      judgeAverage,
      independentEvidenceRate,
      criticalPassRate,
      thresholds
    ),
    provenance,
  };
}

function buildReleaseGate(
  deterministicPassRate: number,
  passAt1Value: number,
  passPowerKValue: number,
  judgeAverage: number | null,
  independentEvidenceRate: number,
  criticalPassRate: number,
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
    thresholdCheck(
      'critical task pass rate',
      criticalPassRate,
      thresholds.criticalPassRate
    ),
  ];
  if (thresholds.requireJudge || judgeAverage !== null) {
    checks.push(
      thresholdCheck('judge average', judgeAverage, thresholds.judgeAverage)
    );
  }
  if (thresholds.requireIndependentEvidence) {
    checks.push(
      thresholdCheck('independent evidence', independentEvidenceRate, 1)
    );
  }
  return { passed: checks.every((check) => check.passed), checks };
}

function thresholdCheck(
  name: string,
  actual: number | null,
  required: number
): ReleaseGate['checks'][number] {
  return {
    name,
    actual,
    required,
    passed: actual !== null && actual >= required,
  };
}

function isIndependent(source: string): boolean {
  return source !== 'unavailable' && !source.startsWith('self-reported');
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

function unknownProvenance(): RunProvenance {
  return {
    systemUnderTest: 'not-provided',
    evidenceObserver: 'not-provided',
    judge: null,
    taskFile: 'not-provided',
    taskSetSha256: 'not-provided',
    sourceRevision: null,
    configuration: {},
  };
}
