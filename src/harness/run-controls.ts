import { join } from 'node:path';

import { NopAgentFactory } from '../adapters/nop-agent.js';
import { OracleAgentFactory } from '../adapters/oracle-agent.js';
import type {
  ControlCheck,
  ControlSummary,
  EvalTask,
  JudgeProvider,
  ReleaseThresholds,
  TrialRecord,
} from '../types.js';
import { runSuite } from './run-suite.js';

const ORACLE_EXPECTATION = 'the reference answer passes every grader';
const NOP_EXPECTATION = 'the do-nothing baseline fails at least one grader';

/**
 * The controls assert on their own records, so the gate is not the point. It
 * still fails when a control run could not measure, which is worth seeing.
 */
const CONTROL_THRESHOLDS: ReleaseThresholds = {
  deterministicPassRate: 0,
  passAt1: 0,
  passPowerK: 0,
  judgeAverage: 0,
  maxInvalidRate: 0,
};

export interface ControlOptions {
  /** Where the two control reports are written, one directory each. */
  reportDirectory: string;
  judgeProvider?: JudgeProvider | undefined;
  concurrency?: number;
}

/**
 * Checks the graders before the graders check a model. Both controls run
 * through the same path as a real eval, so what they exercise is what a real
 * run exercises - the same workspaces, graders, and outcome rules.
 *
 * Budget graders are the exception: both controls stay well inside any turn,
 * cost, or latency limit, so a budget that is set too loosely passes here.
 */
export async function runControls(
  tasks: EvalTask[],
  options: ControlOptions
): Promise<ControlSummary> {
  if (tasks.length === 0)
    throw new Error('At least one task is required to run the controls.');

  const concurrency = options.concurrency ?? 2;
  const shared = {
    tasks,
    trials: 1,
    k: 1,
    concurrency,
    thresholds: CONTROL_THRESHOLDS,
    retries: 0,
    ...(options.judgeProvider ? { judgeProvider: options.judgeProvider } : {}),
  };

  const oracle = await runSuite({
    ...shared,
    factory: new OracleAgentFactory(),
    reportDirectory: join(options.reportDirectory, 'oracle'),
    systemLabel: 'oracle',
  });
  const nop = await runSuite({
    ...shared,
    factory: new NopAgentFactory(),
    reportDirectory: join(options.reportDirectory, 'nop'),
    systemLabel: 'nop',
  });

  const checks = tasks.flatMap((task) => [
    oracleCheck(task, findRecord(oracle.records, task.id)),
    nopCheck(task, findRecord(nop.records, task.id)),
  ]);

  return {
    checks,
    passed: checks.every((check) => check.passed),
    reportDirectory: options.reportDirectory,
  };
}

function oracleCheck(task: EvalTask, record: TrialRecord): ControlCheck {
  if (!record.outcome.scored) {
    return check(
      task,
      'oracle',
      ORACLE_EXPECTATION,
      false,
      `The oracle could not run (${record.outcome.status}): ${record.outcome.detail ?? 'no detail'}`
    );
  }
  if (record.grades.length === 0) {
    return check(
      task,
      'oracle',
      ORACLE_EXPECTATION,
      false,
      'The task declares no expectations, so there is nothing to prove.'
    );
  }

  const failed = record.grades.filter((grade) => !grade.passed);
  return check(
    task,
    'oracle',
    ORACLE_EXPECTATION,
    failed.length === 0,
    failed.length === 0
      ? `${record.grades.length} grader(s) accepted the reference answer.`
      : `Rejected the reference answer: ${failed.map((grade) => `${grade.grader} (${grade.rationale})`).join('; ')}`
  );
}

function nopCheck(task: EvalTask, record: TrialRecord): ControlCheck {
  if (!record.outcome.scored) {
    return check(
      task,
      'nop',
      NOP_EXPECTATION,
      false,
      `The nop control could not run (${record.outcome.status}): ${record.outcome.detail ?? 'no detail'}`
    );
  }

  const failed = record.grades.filter((grade) => !grade.passed);
  return check(
    task,
    'nop',
    NOP_EXPECTATION,
    failed.length > 0,
    failed.length > 0
      ? `Rejected by ${failed.map((grade) => grade.grader).join(', ')}.`
      : 'No grader rejected an empty result, so this task cannot detect a failure.'
  );
}

function findRecord(records: TrialRecord[], taskId: string): TrialRecord {
  const record = records.find((item) => item.taskId === taskId);
  if (!record)
    throw new Error(`The control run produced no record for task ${taskId}.`);
  return record;
}

function check(
  task: EvalTask,
  control: 'nop' | 'oracle',
  expectation: string,
  passed: boolean,
  detail: string
): ControlCheck {
  return { taskId: task.id, control, expectation, passed, detail };
}
