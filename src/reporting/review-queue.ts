import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function summarizeReviewQueue(directory: string): Promise<string> {
  const path = join(directory, 'review-queue.jsonl');
  const contents = await readFile(path, 'utf8');
  const count = contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean).length;
  return `${count} trial${count === 1 ? '' : 's'} waiting for human review in ${path}.`;
}
