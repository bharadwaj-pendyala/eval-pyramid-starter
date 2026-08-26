import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { redactText, redactUnknown } from '../reporting/redact.js';
import type {
  EvalSummary,
  Provenance,
  TaskReliability,
  TrialRecord,
} from '../types.js';

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

/**
 * Humans review model behaviour. Trials that never reached a verdict are
 * harness work, so they are reported separately instead of queued for scoring.
 */
function buildReviewQueue(records: TrialRecord[]): ReviewQueueEntry[] {
  return records
    .filter((record) => record.outcome.scored)
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
  const failures = records.filter(
    (record) => record.outcome.scored && !record.passed
  );
  const invalid = records.filter((record) => !record.outcome.scored);
  const warned = records.filter((record) => record.warnings.length > 0);

  const sections = [
    '# Failures',
    '',
    failures.length === 0
      ? 'No failed trials.'
      : failures
          .map((record) => {
            const reasons = record.grades
              .filter((grade) => !grade.passed)
              .map((grade) => `- ${grade.grader}: ${grade.rationale}`)
              .join('\n');
            return `## ${redactText(record.taskId)}, trial ${record.trialIndex + 1}\n\n${redactText(reasons)}`;
          })
          .join('\n\n'),
    '',
    '# Invalid trials',
    '',
    'These trials measured nothing about the system under test and are excluded from every rate.',
    '',
    invalid.length === 0
      ? 'No invalid trials.'
      : invalid
          .map(
            (record) =>
              `- ${redactText(record.taskId)}, trial ${record.trialIndex + 1}: ${record.outcome.status} — ${redactText(record.outcome.detail ?? 'no detail')}`
          )
          .join('\n'),
  ];

  if (warned.length > 0) {
    sections.push(
      '',
      '# Warnings',
      '',
      'Problems outside the measurement. They do not change any result.',
      '',
      warned
        .map(
          (record) =>
            `- ${redactText(record.taskId)}, trial ${record.trialIndex + 1}: ${redactText(record.warnings.join('; '))}`
        )
        .join('\n')
    );
  }

  return `${sections.join('\n')}\n`;
}

function reportHtml(summary: EvalSummary, records: TrialRecord[]): string {
  const rows = records
    .map(
      (record) => `<tr>
<td>${escapeHtml(redactText(record.taskId))}</td>
<td>${record.trialIndex + 1}</td>
<td><span class="status ${statusClass(record)}">${escapeHtml(resultLabel(record))}</span></td>
<td>${escapeHtml(outcomeLabel(record))}</td>
<td>${escapeHtml(formatDuration(record.durationMs))}</td>
<td>${record.outcome.scored ? formatPercent(average(record.grades.map((grade) => grade.score))) : '&mdash;'}</td>
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
:root{color-scheme:light dark;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.5;--accent:#6366f1;--border:#94a3b8;--muted:#64748b}
body{max-width:72rem;margin:0 auto;padding:2rem 1rem}h1,h2{line-height:1.2}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:1rem}.card{border:1px solid var(--border);border-radius:.6rem;padding:1rem}.value{display:block;font-size:1.6rem;font-weight:700}.pass{color:#15803d}.fail{color:#b91c1c}.invalid{color:var(--muted)}.status{font-weight:700}table{border-collapse:collapse;width:100%;margin-top:1rem}th,td{border-bottom:1px solid var(--border);padding:.65rem;text-align:left}th{color:var(--accent)}.table-wrap{overflow-x:auto}dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem 1rem;margin:0}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}:focus-visible{outline:3px solid var(--accent);outline-offset:2px}@media(max-width:32rem){body{padding:1rem}.cards{grid-template-columns:1fr 1fr}th,td{white-space:nowrap}}
</style>
</head>
<body>
<main>
<h1>Eval Pyramid Report</h1>
<p>Run <code>${escapeHtml(summary.runId)}</code>, generated ${escapeHtml(summary.generatedAt)}.</p>
<p>${summary.trialCount} trial(s): ${summary.scoredTrialCount} scored, ${summary.invalidTrialCount} invalid. Rates below use scored trials only.</p>
<section aria-labelledby="summary-heading">
<h2 id="summary-heading">Summary</h2>
<div class="cards" data-testid="summary-cards">
${card('Release gate', summary.releaseGate.passed ? 'PASS' : 'FAIL', summary.releaseGate.passed)}
${card('Deterministic', formatPercent(summary.deterministicPassRate), (summary.deterministicPassRate ?? 0) >= 1)}
${card('pass@1', formatPercent(summary.passAt1), true)}
${card(`pass@${summary.k}`, formatPercent(summary.passAtK), true)}
${card(`pass^${summary.k}`, formatPercent(summary.passPowerK), true)}
${card('Judge average', formatPercent(summary.judgeAverage), true)}
${card('Invalid trials', formatPercent(summary.invalidRate), summary.invalidRate === 0)}
${card('Total cost', `$${summary.totalCostUsd.toFixed(4)}`, true)}
${card('Median trial', formatDuration(summary.medianTrialDurationMs), true)}
</div>
</section>
${taskSection(summary.tasks, summary.k)}
<section aria-labelledby="trials-heading">
<h2 id="trials-heading">Trials</h2>
<div class="table-wrap"><table>
<thead><tr><th scope="col">Task</th><th scope="col">Trial</th><th scope="col">Result</th><th scope="col">Outcome</th><th scope="col">Duration</th><th scope="col">Score</th><th scope="col">Failed graders</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
</section>
${provenanceSection(summary.provenance)}
</main>
</body>
</html>
`;
}

/** Per task, so one expensive, slow, or unreliable case is visible on its own. */
function taskSection(tasks: TaskReliability[], k: number): string {
  const rows = tasks
    .map(
      (task) => `<tr>
<td>${escapeHtml(redactText(task.taskId))}</td>
<td>${task.scoredTrials}/${task.trials}</td>
<td>${formatPercent(task.passAt1)}</td>
<td>${formatPercent(task.passAtK)}</td>
<td>${formatPercent(task.passPowerK)}</td>
<td>${task.meanCostUsd === null ? 'not measured' : `$${task.meanCostUsd.toFixed(4)}`}</td>
<td>${escapeHtml(formatDuration(task.medianDurationMs))}</td>
</tr>`
    )
    .join('\n');

  return `<section aria-labelledby="tasks-heading">
<h2 id="tasks-heading">Tasks</h2>
<div class="table-wrap"><table>
<thead><tr><th scope="col">Task</th><th scope="col">Scored</th><th scope="col">pass@1</th><th scope="col">pass@${k}</th><th scope="col">pass^${k}</th><th scope="col">Mean cost</th><th scope="col">Median duration</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
</section>`;
}

/** What produced these numbers, so two reports can be compared honestly. */
function provenanceSection(provenance: Provenance | null): string {
  if (!provenance) return '';
  const entries: Array<[string, string]> = [
    ['System under test', provenance.systemUnderTest],
    ['Judge', provenance.judge ?? 'not run'],
    ['Task file', provenance.taskFile ?? 'supplied in memory'],
    ['Task set digest', provenance.taskSetDigest],
    ['Config digest', provenance.configDigest],
    [
      'Commit',
      provenance.git.commit
        ? `${provenance.git.commit}${provenance.git.dirty === true ? ' (uncommitted changes)' : ''}`
        : 'unknown',
    ],
    ['Starter version', provenance.starterVersion],
    ['Node', provenance.nodeVersion],
  ];

  return `<section aria-labelledby="provenance-heading">
<h2 id="provenance-heading">Provenance</h2>
<dl>
${entries.map(([term, value]) => `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(redactText(value))}</dd>`).join('\n')}
</dl>
</section>`;
}

function outcomeLabel(record: TrialRecord): string {
  return record.attempts > 1
    ? `${record.outcome.status} (${record.attempts} attempts)`
    : record.outcome.status;
}

function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null) return 'not measured';
  if (milliseconds >= 1000) return `${(milliseconds / 1000).toFixed(1)} s`;
  return `${Number(milliseconds.toFixed(1))} ms`;
}

function resultLabel(record: TrialRecord): string {
  if (!record.outcome.scored) return 'invalid';
  return record.passed ? 'pass' : 'fail';
}

function statusClass(record: TrialRecord): string {
  if (!record.outcome.scored) return 'invalid';
  return record.passed ? 'pass' : 'fail';
}

function card(label: string, value: string, passed: boolean): string {
  return `<div class="card"><span>${escapeHtml(label)}</span><strong class="value ${passed ? 'pass' : 'fail'}">${escapeHtml(value)}</strong></div>`;
}

function formatPercent(value: number | null): string {
  if (value === null) return 'not measured';
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
