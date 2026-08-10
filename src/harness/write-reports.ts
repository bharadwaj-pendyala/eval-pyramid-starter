import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { redactText, redactUnknown } from '../reporting/redact.js';
import type { EvalSummary, TrialRecord } from '../types.js';

export async function writeReports(
  directory: string,
  summary: EvalSummary,
  records: TrialRecord[]
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const safeSummary = redactUnknown(summary);
  const safeRecords = records.map((record) => redactUnknown(record));
  const reviewQueue = buildReviewQueue(records).map((entry) =>
    redactUnknown(entry)
  );

  await Promise.all([
    writeFile(
      join(directory, 'summary.json'),
      `${JSON.stringify(safeSummary, null, 2)}\n`,
      'utf8'
    ),
    writeFile(
      join(directory, 'trials.jsonl'),
      `${safeRecords.map((record) => JSON.stringify(record)).join('\n')}\n`,
      'utf8'
    ),
    writeFile(
      join(directory, 'review-queue.jsonl'),
      reviewQueue.length > 0
        ? `${reviewQueue.map((entry) => JSON.stringify(entry)).join('\n')}\n`
        : '',
      'utf8'
    ),
    writeFile(join(directory, 'failures.md'), failureMarkdown(records), 'utf8'),
    writeFile(
      join(directory, 'index.html'),
      reportHtml(summary, records),
      'utf8'
    ),
  ]);
}

interface ReviewQueueEntry {
  taskId: string;
  trialIndex: number;
  reasons: string[];
  output: unknown;
  humanScore: null;
  notes: string;
}

function buildReviewQueue(records: TrialRecord[]): ReviewQueueEntry[] {
  return records
    .filter(
      (record) =>
        !record.passed ||
        record.grades.some((grade) => grade.rationale.startsWith('Unknown:'))
    )
    .map((record) => ({
      taskId: record.taskId,
      trialIndex: record.trialIndex,
      reasons: record.grades
        .filter((grade) => !grade.passed)
        .map((grade) => `${grade.grader}: ${grade.rationale}`),
      output: record.run.output,
      humanScore: null,
      notes: '',
    }));
}

function failureMarkdown(records: TrialRecord[]): string {
  const failures = records.filter((record) => !record.passed);
  if (failures.length === 0) return '# Failures\n\nNo failed trials.\n';

  const sections = failures.map((record) => {
    const reasons = record.grades
      .filter((grade) => !grade.passed)
      .map((grade) => `- ${grade.grader}: ${grade.rationale}`)
      .join('\n');
    return `## ${redactText(record.taskId)}, trial ${record.trialIndex + 1}\n\n${redactText(reasons)}`;
  });
  return `# Failures\n\n${sections.join('\n\n')}\n`;
}

function reportHtml(summary: EvalSummary, records: TrialRecord[]): string {
  const rows = records
    .map(
      (record) => `<tr>
<td>${escapeHtml(redactText(record.taskId))}</td>
<td>${record.trialIndex + 1}</td>
<td><span class="status ${record.passed ? 'pass' : 'fail'}">${record.passed ? 'pass' : 'fail'}</span></td>
<td>${formatPercent(average(record.grades.map((grade) => grade.score)))}</td>
<td>${escapeHtml(
        redactText(
          record.grades
            .filter((grade) => !grade.passed)
            .map((grade) => grade.grader)
            .join(', ') || 'none'
        )
      )}</td>
</tr>`
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Eval Pyramid Report</title>
<style>
:root{color-scheme:light dark;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.5;--accent:#6366f1;--border:#94a3b8}
body{max-width:72rem;margin:0 auto;padding:2rem 1rem}h1,h2{line-height:1.2}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:1rem}.card{border:1px solid var(--border);border-radius:.6rem;padding:1rem}.value{display:block;font-size:1.6rem;font-weight:700}.pass{color:#15803d}.fail{color:#b91c1c}.status{font-weight:700}table{border-collapse:collapse;width:100%;margin-top:1rem}th,td{border-bottom:1px solid var(--border);padding:.65rem;text-align:left}th{color:var(--accent)}.table-wrap{overflow-x:auto}:focus-visible{outline:3px solid var(--accent);outline-offset:2px}@media(max-width:32rem){body{padding:1rem}.cards{grid-template-columns:1fr 1fr}th,td{white-space:nowrap}}
</style>
</head>
<body>
<main>
<h1>Eval Pyramid Report</h1>
<p>Run <code>${escapeHtml(summary.runId)}</code>, generated ${escapeHtml(summary.generatedAt)}.</p>
<section aria-labelledby="summary-heading">
<h2 id="summary-heading">Summary</h2>
<div class="cards" data-testid="summary-cards">
${card('Release gate', summary.releaseGate.passed ? 'PASS' : 'FAIL', summary.releaseGate.passed)}
${card('Deterministic', formatPercent(summary.deterministicPassRate), summary.deterministicPassRate >= 1)}
${card('pass@1', formatPercent(summary.passAt1), true)}
${card(`pass@${summary.k}`, formatPercent(summary.passAtK), true)}
${card(`pass^${summary.k}`, formatPercent(summary.passPowerK), true)}
${card('Judge average', summary.judgeAverage === null ? 'not run' : formatPercent(summary.judgeAverage), true)}
</div>
</section>
<section aria-labelledby="trials-heading">
<h2 id="trials-heading">Trials</h2>
<div class="table-wrap"><table>
<thead><tr><th scope="col">Task</th><th scope="col">Trial</th><th scope="col">Result</th><th scope="col">Score</th><th scope="col">Failed graders</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
</section>
</main>
</body>
</html>
`;
}

function card(label: string, value: string, passed: boolean): string {
  return `<div class="card"><span>${escapeHtml(label)}</span><strong class="value ${passed ? 'pass' : 'fail'}">${escapeHtml(value)}</strong></div>`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    const replacements: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return replacements[character] ?? character;
  });
}
