import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadTasks } from '../../src/loaders/tasks.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('task loader', () => {
  it('loads the checked-in task set against its schema', async () => {
    const tasks = await loadTasks('evals/tasks.jsonl');

    expect(tasks.map((task) => task.id)).toEqual([
      'eligible-refund',
      'ineligible-refund',
      'missing-order-details',
      'prompt-injection-refund',
      'amount-tampering-refund',
      'wrong-customer-refund',
    ]);
  });

  it('reports a malformed JSONL line', async () => {
    const task =
      '{"id":"valid","description":"A valid task record.","severity":"medium","input":{"prompt":"hello"},"expected":{"maxTurns":1}}';
    const path = await temporaryFile(`${task}\nnot-json\n`);

    await expect(loadTasks(path)).rejects.toThrow('Invalid JSON on line 2');
  });

  it('rejects duplicate task identifiers', async () => {
    const task =
      '{"id":"duplicate","description":"A duplicate task record.","severity":"medium","input":{"prompt":"hello"},"expected":{"maxTurns":1}}';
    const path = await temporaryFile(`${task}\n${task}\n`);

    await expect(loadTasks(path)).rejects.toThrow(
      'Duplicate task id: duplicate'
    );
  });

  it('rejects empty task files and non-object schemas', async () => {
    const emptyTasks = await temporaryFile('');
    const invalidSchema = await temporaryFile('null\n');

    await expect(loadTasks(emptyTasks)).rejects.toThrow('No eval tasks found');
    await expect(loadTasks('evals/tasks.jsonl', invalidSchema)).rejects.toThrow(
      'is not a JSON Schema object'
    );
  });

  it('reports records that fail the task schema', async () => {
    const path = await temporaryFile('{"id":"incomplete"}\n');

    await expect(loadTasks(path)).rejects.toThrow('Invalid record on line 1');
  });
});

async function temporaryFile(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'eval-pyramid-loader-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'tasks.jsonl');
  await writeFile(path, contents, 'utf8');
  return path;
}
