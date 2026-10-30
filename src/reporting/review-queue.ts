import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface ReviewQueueEntry {
  runId: string;
  taskId: string;
  trialIndex: number;
  reasons: string[];
  output: unknown;
}

export interface ReviewDecision {
  runId: string;
  taskId: string;
  trialIndex: number;
  humanScore: number;
  notes: string;
  reviewedAt: string;
}

export interface ReviewQueueStatus {
  runId: string;
  total: number;
  completed: number;
  pending: ReviewQueueEntry[];
  decisionsFile: string;
}

export async function reviewQueueStatus(
  reportRoot: string
): Promise<ReviewQueueStatus> {
  const entries = await readQueue(
    join(reportRoot, 'latest', 'review-queue.jsonl')
  );
  const runId = entries[0]?.runId ?? (await latestRunId(reportRoot));
  const decisionsFile = join(reportRoot, 'reviews', `${runId}.jsonl`);
  const decisions = await readDecisions(decisionsFile);
  const latest = new Map(
    decisions.map((decision) => [decisionKey(decision), decision])
  );
  const pending = entries.filter((entry) => !latest.has(decisionKey(entry)));
  return {
    runId,
    total: entries.length,
    completed: entries.length - pending.length,
    pending,
    decisionsFile,
  };
}

export async function summarizeReviewQueue(
  reportRoot: string
): Promise<string> {
  const status = await reviewQueueStatus(reportRoot);
  const count = status.pending.length;
  return `${count} trial${count === 1 ? '' : 's'} waiting for human review in run ${status.runId}. Decisions are stored in ${status.decisionsFile}.`;
}

export async function adjudicateReview(
  reportRoot: string,
  taskId: string,
  trialIndex: number,
  humanScore: number,
  notes: string
): Promise<ReviewDecision> {
  if (!Number.isInteger(trialIndex) || trialIndex < 0) {
    throw new Error('trial must be a zero-based non-negative integer.');
  }
  if (!Number.isFinite(humanScore) || humanScore < 0 || humanScore > 1) {
    throw new Error('score must be between 0 and 1.');
  }
  if (!notes.trim()) throw new Error('notes must explain the human decision.');
  const status = await reviewQueueStatus(reportRoot);
  const entry = status.pending.find(
    (candidate) =>
      candidate.taskId === taskId && candidate.trialIndex === trialIndex
  );
  if (!entry) {
    throw new Error(
      `No pending review exists for task ${taskId}, trial ${trialIndex}.`
    );
  }
  const decision: ReviewDecision = {
    runId: status.runId,
    taskId,
    trialIndex,
    humanScore,
    notes: notes.trim(),
    reviewedAt: new Date().toISOString(),
  };
  await mkdir(join(reportRoot, 'reviews'), { recursive: true });
  await appendFile(
    status.decisionsFile,
    `${JSON.stringify(decision)}\n`,
    'utf8'
  );
  return decision;
}

export async function exportReviewDecisions(
  reportRoot: string
): Promise<string> {
  const status = await reviewQueueStatus(reportRoot);
  const decisions = await readDecisions(status.decisionsFile);
  // Read the immutable run copy, because `latest` may already point at a newer run.
  const queue = await readQueue(
    join(reportRoot, 'runs', status.runId, 'review-queue.jsonl')
  );
  const byKey = new Map(queue.map((entry) => [decisionKey(entry), entry]));
  const rows = decisions.map((decision) => {
    const entry = byKey.get(decisionKey(decision));
    return {
      id: `${decision.taskId}-trial-${decision.trialIndex}`,
      runId: decision.runId,
      taskId: decision.taskId,
      output: entry?.output ?? null,
      failureReasons: entry?.reasons ?? [],
      humanScore: decision.humanScore,
      notes: decision.notes,
      reviewedAt: decision.reviewedAt,
    };
  });
  const output = join(
    reportRoot,
    'reviews',
    `${status.runId}-calibration-candidates.jsonl`
  );
  await mkdir(join(reportRoot, 'reviews'), { recursive: true });
  await writeFile(
    output,
    rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '',
    'utf8'
  );
  return output;
}

async function latestRunId(reportRoot: string): Promise<string> {
  const contents = await readFile(
    join(reportRoot, 'latest', 'summary.json'),
    'utf8'
  );
  const value: unknown = JSON.parse(contents);
  if (!isRecord(value) || typeof value['runId'] !== 'string') {
    throw new Error('Latest summary does not contain a runId.');
  }
  return value['runId'];
}

async function readQueue(path: string): Promise<ReviewQueueEntry[]> {
  const values = await readJsonl(path);
  return values.map((value, index) => {
    if (
      !isRecord(value) ||
      typeof value['runId'] !== 'string' ||
      typeof value['taskId'] !== 'string' ||
      !Number.isInteger(value['trialIndex']) ||
      typeof value['trialIndex'] !== 'number' ||
      !Array.isArray(value['reasons']) ||
      !value['reasons'].every((reason) => typeof reason === 'string')
    ) {
      throw new Error(`Invalid review queue entry on line ${index + 1}.`);
    }
    return {
      runId: value['runId'],
      taskId: value['taskId'],
      trialIndex: value['trialIndex'],
      reasons: value['reasons'],
      output: value['output'],
    };
  });
}

async function readDecisions(path: string): Promise<ReviewDecision[]> {
  const values = await readJsonl(path, true);
  return values.map((value, index) => {
    if (
      !isRecord(value) ||
      typeof value['runId'] !== 'string' ||
      typeof value['taskId'] !== 'string' ||
      !Number.isInteger(value['trialIndex']) ||
      typeof value['trialIndex'] !== 'number' ||
      typeof value['humanScore'] !== 'number' ||
      typeof value['notes'] !== 'string' ||
      typeof value['reviewedAt'] !== 'string'
    ) {
      throw new Error(`Invalid review decision on line ${index + 1}.`);
    }
    return value as unknown as ReviewDecision;
  });
}

async function readJsonl(
  path: string,
  missingIsEmpty = false
): Promise<unknown[]> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (
      missingIsEmpty &&
      isRecord(error) &&
      typeof error['code'] === 'string' &&
      error['code'] === 'ENOENT'
    ) {
      return [];
    }
    throw error;
  }
  return contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

function decisionKey(value: {
  runId: string;
  taskId: string;
  trialIndex: number;
}): string {
  return `${value.runId}\0${value.taskId}\0${value.trialIndex}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
