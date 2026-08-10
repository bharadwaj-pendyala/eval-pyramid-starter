import type { AgentRun, EvalTask, Grade, JudgeProvider } from '../types.js';

export async function gradeWithJudge(
  task: EvalTask,
  run: AgentRun,
  provider: JudgeProvider
): Promise<Grade[]> {
  const grades: Grade[] = [];

  for (const criterion of task.rubric ?? []) {
    const result = await provider.score({ task, run, criterion });
    const passed = !result.unknown && result.score >= criterion.minimumScore;
    grades.push({
      grader: `judge:${criterion.id}`,
      score: result.score,
      passed,
      rationale: result.unknown
        ? `Unknown: ${result.rationale}`
        : `${result.rationale} Confidence ${result.confidence.toFixed(2)}.`,
    });
  }

  return grades;
}
