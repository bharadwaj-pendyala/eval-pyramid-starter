import { NopAgentFactory } from '../adapters/nop-agent.js';
import { OracleAgentFactory } from '../adapters/oracle-agent.js';
import { gradeDeterministically } from '../graders/deterministic.js';
import { gradeWithJudge } from '../graders/model-judge.js';
import type {
  AgentRun,
  ControlCheck,
  ControlSummary,
  EvalTask,
  Grade,
  JudgeProvider,
} from '../types.js';

const ORACLE_EXPECTATION = 'the reference answer passes every grader';
const NOP_EXPECTATION = 'the do-nothing baseline fails at least one grader';

/**
 * Checks the graders before the graders check a model. Two controls bracket
 * every task: a correct answer must pass it, and an empty one must not.
 */
export async function runControls(
  tasks: EvalTask[],
  judgeProvider?: JudgeProvider
): Promise<ControlSummary> {
  if (tasks.length === 0)
    throw new Error('At least one task is required to run the controls.');

  const oracle = await new OracleAgentFactory().create();
  const nop = await new NopAgentFactory().create();
  const checks: ControlCheck[] = [];

  for (const task of tasks) {
    checks.push(
      await oracleCheck(
        task,
        () => oracle.run(task, controlContext(task)),
        judgeProvider
      )
    );
    checks.push(
      await nopCheck(
        task,
        () => nop.run(task, controlContext(task)),
        judgeProvider
      )
    );
  }

  return { checks, passed: checks.every((check) => check.passed) };
}

async function oracleCheck(
  task: EvalTask,
  run: () => Promise<AgentRun>,
  judgeProvider: JudgeProvider | undefined
): Promise<ControlCheck> {
  let grades: Grade[];
  try {
    grades = await gradeControlRun(task, await run(), judgeProvider);
  } catch (error) {
    return check(task, 'oracle', ORACLE_EXPECTATION, false, message(error));
  }

  const failed = grades.filter((grade) => !grade.passed);
  return check(
    task,
    'oracle',
    ORACLE_EXPECTATION,
    failed.length === 0,
    failed.length === 0
      ? `${grades.length} grader(s) accepted the reference answer.`
      : `Rejected the reference answer: ${describe(failed)}.`
  );
}

async function nopCheck(
  task: EvalTask,
  run: () => Promise<AgentRun>,
  judgeProvider: JudgeProvider | undefined
): Promise<ControlCheck> {
  let grades: Grade[];
  try {
    grades = await gradeControlRun(task, await run(), judgeProvider);
  } catch (error) {
    return check(task, 'nop', NOP_EXPECTATION, false, message(error));
  }

  const failed = grades.filter((grade) => !grade.passed);
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

async function gradeControlRun(
  task: EvalTask,
  run: AgentRun,
  judgeProvider: JudgeProvider | undefined
): Promise<Grade[]> {
  const grades = gradeDeterministically(task, run);
  if (grades.length === 0)
    throw new Error('The task declares no deterministic expectations.');
  if (!judgeProvider) return grades;
  return [...grades, ...(await gradeWithJudge(task, run, judgeProvider))];
}

function controlContext(task: EvalTask): {
  runId: string;
  trialIndex: number;
  workspace: string;
} {
  // Controls never touch a workspace: they exercise the graders, not a system.
  return { runId: `control-${task.id}`, trialIndex: 0, workspace: '' };
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

function describe(grades: Grade[]): string {
  return grades
    .map((grade) => `${grade.grader} (${grade.rationale})`)
    .join('; ');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown control failure';
}
