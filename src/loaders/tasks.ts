import { readFile } from 'node:fs/promises';

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Schema } from 'ajv';

import type { EvalTask } from '../types.js';
import { loadValidatedJsonl } from './jsonl.js';

export async function loadTasks(
  taskFile: string,
  schemaFile = 'evals/eval-task.schema.json'
): Promise<EvalTask[]> {
  const schemaContents = await readFile(schemaFile, 'utf8');
  const schema: unknown = JSON.parse(schemaContents);
  if (!isSchema(schema))
    throw new Error(`Task schema ${schemaFile} is not a JSON Schema object.`);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile<EvalTask>(schema);
  const tasks = await loadValidatedJsonl(taskFile, validate);

  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) {
      throw new Error(`Duplicate task id: ${task.id}`);
    }
    ids.add(task.id);
  }

  if (tasks.length === 0) {
    throw new Error(`No eval tasks found in ${taskFile}`);
  }

  return tasks;
}

function isSchema(value: unknown): value is Schema {
  return (
    typeof value === 'boolean' ||
    (typeof value === 'object' && value !== null && !Array.isArray(value))
  );
}
