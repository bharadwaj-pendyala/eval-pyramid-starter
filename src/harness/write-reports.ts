import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { redactText, redactUnknown } from '../reporting/redact.js';
import type { EvalSummary, Grade, TrialRecord } from '../types.js';

export interface ReportLocations {
  runDirectory: string;
  latestDirectory: string;
}

export async function writeReports(
  reportRoot: string,
  summary: EvalSummary,
  records: TrialRecord[]
): Promise<ReportLocations> {
  if (!/^[a-zA-Z0-9._-]+$/u.test(summary.runId)) {
    throw new Error(
      'runId may contain only letters, numbers, dot, underscore, and hyphen.'
    );
  }
  const runDirectory = join(reportRoot, 'runs', summary.runId);
  const latestDirectory = join(reportRoot, 'latest');
  const latestTemporary = join(
    reportRoot,
    `.latest-${summary.runId}-${process.pid}`
  );
  await mkdir(join(reportRoot, 'runs'), { recursive: true });
  await mkdir(runDirectory, { recursive: false });
  await writeReportSet(runDirectory, summary, records);
  await rm(latestTemporary, { recursive: true, force: true });
  await mkdir(latestTemporary, { recursive: false });
  try {
    await writeReportSet(latestTemporary, summary, records);
    await rm(latestDirectory, { recursive: true, force: true });
    await rename(latestTemporary, latestDirectory);
  } finally {
    await rm(latestTemporary, { recursive: true, force: true });
  }
  return { runDirectory, latestDirectory };
}

async function writeReportSet(
  directory: string,
  summary: EvalSummary,
  records: TrialRecord[]
): Promise<void> {
  const safeSummary = redactUnknown(summary);
  const safeRecords = records.map((record) => redactUnknown(record));
  const reviewQueue = buildReviewQueue(summary.runId, records).map((entry) =>
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
  runId: string;
  taskId: string;
  severity: string;
  trialIndex: number;
  reasons: string[];
  output: unknown;
  humanScore: null;
  notes: string;
}

function buildReviewQueue(
  runId: string,
  records: TrialRecord[]
): ReviewQueueEntry[] {
  const sampledPasses = firstPassPerTask(records);
  return records
    .filter(
      (record) =>
        !record.passed ||
        record.grades.some((grade) => grade.rationale.startsWith('Unknown:')) ||
        sampledPasses.has(record)
    )
    .map((record) => ({
      runId,
      taskId: record.taskId,
      severity: record.severity,
      trialIndex: record.trialIndex,
      reasons: sampledPasses.has(record)
        ? ['sampled pass: check for a false pass']
        : record.grades
            .filter((grade) => !grade.passed)
            .map((grade) => `${grade.grader}: ${grade.rationale}`),
      output: record.run.output,
      humanScore: null,
      notes: '',
    }));
}

// A queue of failures alone never shows a reviewer a false pass.
function firstPassPerTask(records: TrialRecord[]): Set<TrialRecord> {
  const sampled = new Map<string, TrialRecord>();
  for (const record of records) {
    const clean =
      record.passed &&
      !record.grades.some((grade) => grade.rationale.startsWith('Unknown:'));
    if (clean && !sampled.has(record.taskId))
      sampled.set(record.taskId, record);
  }
  return new Set(sampled.values());
}

function failureMarkdown(records: TrialRecord[]): string {
  const failures = records.filter((record) => !record.passed);
  if (failures.length === 0) return '# Failures\n\nNo failed trials.\n';

  const sections = failures.map((record) => {
    const reasons = record.grades
      .filter((grade) => !grade.passed)
      .map((grade) => `- ${grade.grader}: ${grade.rationale}`)
      .join('\n');
    return `## ${redactText(record.taskId)}, trial ${record.trialIndex + 1}\n\nSeverity: ${record.severity}\n\nEvidence: ${redactText(record.run.evidenceSource)}\n\n${redactText(reasons)}`;
  });
  return `# Failures\n\n${sections.join('\n\n')}\n`;
}

function reportHtml(summary: EvalSummary, records: TrialRecord[]): string {
  const rows = records
    .map(
      (record) => `<tr>
<td>${escapeHtml(redactText(record.taskId))}</td>
<td>${escapeHtml(record.severity)}</td>
<td>${record.trialIndex + 1}</td>
<td><span class="status ${record.passed ? 'pass' : 'fail'}">${record.passed ? 'pass' : 'fail'}</span></td>
<td>${escapeHtml(gradeStatus(record.grades))}</td>
<td>${escapeHtml(redactText(record.run.evidenceSource))}</td>
<td>${recordDetails(record)}</td>
</tr>`
    )
    .join('\n');
  const checks = summary.releaseGate.checks
    .map(
      (check) => `<tr>
<td>${escapeHtml(check.name)}</td>
<td>${check.actual === null ? 'missing' : formatPercent(check.actual)}</td>
<td>${formatPercent(check.required)}</td>
<td><span class="status ${check.passed ? 'pass' : 'fail'}">${check.passed ? 'pass' : 'fail'}</span></td>
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
body{max-width:90rem;margin:0 auto;padding:2rem 1rem}h1,h2{line-height:1.2}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:1rem}.card{border:1px solid var(--border);border-radius:.6rem;padding:1rem;min-width:0}.value{display:block;font-size:1.6rem;font-weight:700;overflow-wrap:anywhere}.pass{color:#15803d}.fail{color:#b91c1c}.neutral{color:inherit}.status{font-weight:700}table{border-collapse:collapse;width:100%;margin-top:1rem}th,td{border-bottom:1px solid var(--border);padding:.65rem;text-align:left;vertical-align:top}th{color:var(--accent)}.table-wrap{max-width:100%;overflow-x:auto}details{min-width:8rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:36rem}dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:.4rem 1rem}dt{font-weight:700}dd{margin:0;overflow-wrap:anywhere}:focus-visible{outline:3px solid var(--accent);outline-offset:2px}@media(max-width:32rem){body{padding:1rem}.cards{grid-template-columns:1fr 1fr}th,td{white-space:nowrap}}
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
${card('Deterministic', formatPercent(summary.deterministicPassRate), checkPassed(summary, 'deterministic pass rate'))}
${card('pass@1', formatPercent(summary.passAt1), checkPassed(summary, 'pass@1'))}
${card(`pass@${summary.k}`, formatPercent(summary.passAtK), null)}
${card(`pass^${summary.k}`, formatPercent(summary.passPowerK), checkPassed(summary, 'pass^k'))}
${card('Independent evidence', formatPercent(summary.independentEvidenceRate), checkPassed(summary, 'independent evidence'))}
${card('Judge average', summary.judgeAverage === null ? 'not run' : formatPercent(summary.judgeAverage), checkPassed(summary, 'judge average'))}
</div>
</section>
<section aria-labelledby="gate-heading">
<h2 id="gate-heading">Release gate checks</h2>
<div class="table-wrap"><table>
<thead><tr><th scope="col">Check</th><th scope="col">Actual</th><th scope="col">Required</th><th scope="col">Result</th></tr></thead>
<tbody>${checks}</tbody>
</table></div>
</section>
<section aria-labelledby="provenance-heading">
<h2 id="provenance-heading">Provenance</h2>
<dl>
<dt>System</dt><dd>${escapeHtml(summary.provenance.systemUnderTest)}</dd>
<dt>Observer</dt><dd>${escapeHtml(summary.provenance.evidenceObserver)}</dd>
<dt>Judge</dt><dd>${escapeHtml(summary.provenance.judge ?? 'not run')}</dd>
<dt>Task SHA-256</dt><dd><code>${escapeHtml(summary.provenance.taskSetSha256)}</code></dd>
<dt>Revision</dt><dd><code>${escapeHtml(summary.provenance.sourceRevision ?? 'unavailable')}</code></dd>
</dl>
</section>
<section aria-labelledby="trials-heading">
<h2 id="trials-heading">Trials</h2>
<div class="table-wrap"><table>
<thead><tr><th scope="col">Task</th><th scope="col">Severity</th><th scope="col">Trial</th><th scope="col">Result</th><th scope="col">Grader checks</th><th scope="col">Evidence</th><th scope="col">Details</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
</section>
</main>
</body>
</html>
`;
}

function gradeStatus(grades: Grade[]): string {
  const passed = grades.filter((grade) => grade.passed).length;
  return `${passed}/${grades.length} passed`;
}

function recordDetails(record: TrialRecord): string {
  const details = redactUnknown({
    output: record.run.output,
    grades: record.grades.map((grade) => ({
      grader: grade.grader,
      score: grade.score,
      passed: grade.passed,
      rationale: grade.rationale,
    })),
  });
  return `<details><summary>inspect</summary><pre>${escapeHtml(JSON.stringify(details, null, 2))}</pre></details>`;
}

function checkPassed(summary: EvalSummary, name: string): boolean | null {
  const check = summary.releaseGate.checks.find((item) => item.name === name);
  return check?.passed ?? null;
}

function card(label: string, value: string, passed: boolean | null): string {
  const status = passed === null ? 'neutral' : passed ? 'pass' : 'fail';
  return `<div class="card"><span>${escapeHtml(label)}</span><strong class="value ${status}">${escapeHtml(value)}</strong></div>`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
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
