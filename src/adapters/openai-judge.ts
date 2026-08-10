import type { JudgeProvider, JudgeRequest, JudgeScore } from '../types.js';

interface OpenAIJudgeOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class OpenAIJudgeProvider implements JudgeProvider {
  readonly name: string;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAIJudgeOptions) {
    if (!options.apiKey.trim())
      throw new Error('OpenAI judge requires a non-empty API key.');
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
    this.#fetch = options.fetchImpl ?? fetch;
    this.name = `openai:${options.model}`;
  }

  async score(request: JudgeRequest): Promise<JudgeScore> {
    const response = await this.#fetch(`${this.#baseUrl}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.#model,
        input: [
          {
            role: 'developer',
            content:
              'Grade exactly one criterion. Use only the supplied task, output, and criterion. Return unknown when evidence is insufficient.',
          },
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
        text: {
          format: {
            type: 'json_schema',
            name: 'eval_grade',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['score', 'confidence', 'rationale', 'unknown'],
              properties: {
                score: { type: 'number', minimum: 0, maximum: 1 },
                confidence: { type: 'number', minimum: 0, maximum: 1 },
                rationale: { type: 'string' },
                unknown: { type: 'boolean' },
              },
            },
          },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI judge request failed with HTTP ${response.status}.`
      );
    }

    const payload: unknown = await response.json();
    const text = extractOutputText(payload);
    const parsed: unknown = JSON.parse(text);
    if (!isJudgeScore(parsed)) {
      throw new Error('OpenAI judge returned an invalid structured score.');
    }
    return parsed;
  }
}

function extractOutputText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload['output'])) {
    throw new Error('OpenAI judge response did not contain output.');
  }

  for (const item of payload['output']) {
    if (!isRecord(item) || !Array.isArray(item['content'])) continue;
    for (const content of item['content']) {
      if (
        isRecord(content) &&
        content['type'] === 'output_text' &&
        typeof content['text'] === 'string'
      ) {
        return content['text'];
      }
    }
  }

  throw new Error('OpenAI judge response did not contain output_text.');
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
