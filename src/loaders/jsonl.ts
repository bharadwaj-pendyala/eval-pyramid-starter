import { readFile } from 'node:fs/promises';

import type { ValidateFunction } from 'ajv';

export async function loadValidatedJsonl<T>(
  filePath: string,
  validate: ValidateFunction<T>
): Promise<T[]> {
  const contents = await readFile(filePath, 'utf8');
  const lines = contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return lines.map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown JSON error';
      throw new Error(
        `Invalid JSON on line ${index + 1} of ${filePath}: ${message}`,
        { cause: error }
      );
    }

    if (!validate(value)) {
      const details = validate.errors
        ?.map(
          (item) =>
            `${item.instancePath || '/'} ${item.message ?? 'is invalid'}`
        )
        .join('; ');
      throw new Error(
        `Invalid record on line ${index + 1} of ${filePath}: ${details ?? 'schema validation failed'}`
      );
    }

    return value;
  });
}
