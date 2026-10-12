import type { JudgeProvider, JudgeRequest, JudgeScore } from '../types.js';

interface AnthropicJudgeOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  anthropicVersion?: string;
  fetchImpl?: typeof fetch;
}

const GRADE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'confidence', 'rationale', 'unknown'],
  properties: {
    score: { type: 'number', minimum: 0, maximum: 1 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string' },
    unknown: { type: 'boolean' },
  },
};

export class AnthropicJudgeProvider implements JudgeProvider {
  readonly name: string;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #anthropicVersion: string;
  readonly #fetch: typeof fetch;

  constructor(options: AnthropicJudgeOptions) {
    if (!options.apiKey.trim())
      throw new Error('Anthropic judge requires a non-empty API key.');
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#baseUrl = options.baseUrl ?? 'https://api.anthropic.com/v1';
    this.#anthropicVersion = options.anthropicVersion ?? '2023-06-01';
    this.#fetch = options.fetchImpl ?? fetch;
    this.name = `anthropic:${options.model}`;
  }

  async score(request: JudgeRequest): Promise<JudgeScore> {
    const response = await this.#fetch(`${this.#baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.#apiKey,
        'anthropic-version': this.#anthropicVersion,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.#model,
        max_tokens: 4096,
        system:
          'Grade exactly one criterion. Use only the supplied task, output, and criterion. Return unknown when evidence is insufficient.',
        messages: [
          {
            role: 'user',
            content: JSON.stringify({
              task: request.task.description,
              input: request.task.input,
              output: request.run.output,
              criterion: request.criterion.description,
            }),
          },
        ],
        output_config: {
          format: {
            type: 'json_schema',
            schema: GRADE_SCHEMA,
          },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Anthropic judge request failed with HTTP ${response.status}.`
      );
    }

    const payload: unknown = await response.json();
    const text = extractOutputText(payload);
    const parsed: unknown = JSON.parse(text);
    if (!isJudgeScore(parsed)) {
      throw new Error('Anthropic judge returned an invalid structured score.');
    }
    return parsed;
  }
}

function extractOutputText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload['content'])) {
    throw new Error('Anthropic judge response did not contain content.');
  }

  for (const block of payload['content']) {
    if (
      isRecord(block) &&
      block['type'] === 'text' &&
      typeof block['text'] === 'string'
    ) {
      return block['text'];
    }
  }

  throw new Error('Anthropic judge response did not contain a text block.');
}

function isJudgeScore(value: unknown): value is JudgeScore {
  return (
    isRecord(value) &&
    typeof value['score'] === 'number' &&
    value['score'] >= 0 &&
    value['score'] <= 1 &&
    typeof value['confidence'] === 'number' &&
    value['confidence'] >= 0 &&
    value['confidence'] <= 1 &&
    typeof value['rationale'] === 'string' &&
    typeof value['unknown'] === 'boolean'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
