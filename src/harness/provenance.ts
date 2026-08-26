import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import type {
  EvalTask,
  GitProvenance,
  JsonValue,
  Provenance,
  ReleaseThresholds,
} from '../types.js';

const run = promisify(execFile);

export interface ProvenanceInput {
  tasks: EvalTask[];
  thresholds: ReleaseThresholds;
  trials: number;
  k: number;
  concurrency: number;
  systemUnderTest: string;
  judge?: string | undefined;
  taskFile?: string | undefined;
}

export async function computeProvenance(
  input: ProvenanceInput
): Promise<Provenance> {
  const taskDigests = input.tasks.map((task) => ({
    taskId: task.id,
    digest: digest(task as unknown as JsonValue),
  }));

  return {
    starterVersion: await readStarterVersion(),
    nodeVersion: process.version,
    git: await readGitProvenance(),
    taskFile: input.taskFile ?? null,
    taskSetDigest: digestText(
      taskDigests
        .map((entry) => `${entry.taskId}:${entry.digest}`)
        .sort()
        .join('\n')
    ),
    taskDigests,
    configDigest: digest({
      thresholds: input.thresholds as unknown as JsonValue,
      trials: input.trials,
      k: input.k,
      concurrency: input.concurrency,
      systemUnderTest: input.systemUnderTest,
      judge: input.judge ?? null,
    }),
    systemUnderTest: input.systemUnderTest,
    judge: input.judge ?? null,
  };
}

/** Stable across key order, so an unchanged task never changes its digest. */
export function digest(value: JsonValue): string {
  return digestText(canonicalize(value));
}

function digestText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;

  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`);
  return `{${entries.join(',')}}`;
}

async function readStarterVersion(): Promise<string> {
  try {
    const contents = await readFile(
      new URL('../../package.json', import.meta.url),
      'utf8'
    );
    const parsed: unknown = JSON.parse(contents);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      typeof parsed.version === 'string'
    ) {
      return parsed.version;
    }
  } catch {
    // A packaged copy without its manifest still produces a usable report.
  }
  return 'unknown';
}

/**
 * Best effort: a checkout without Git still reports, it just reports honestly
 * that it does not know which revision produced the numbers.
 */
async function readGitProvenance(): Promise<GitProvenance> {
  const commit = await gitOutput(['rev-parse', 'HEAD']);
  if (commit === null) return { commit: null, dirty: null };
  const status = await gitOutput(['status', '--porcelain']);
  return { commit, dirty: status === null ? null : status.length > 0 };
}

async function gitOutput(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', args, { encoding: 'utf8' });
    return stdout.trim();
  } catch {
    return null;
  }
}
