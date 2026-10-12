import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AnthropicJudgeProvider } from '../../src/adapters/anthropic-judge.js';
import { FakeJudgeProvider } from '../../src/adapters/fake-judge.js';
import { OpenAIJudgeProvider } from '../../src/adapters/openai-judge.js';
import { gradeWithJudge } from '../../src/graders/model-judge.js';
import { calibrateJudge } from '../../src/harness/calibrate-judge.js';
import type { AgentRun, EvalTask, JudgeRequest } from '../../src/types.js';

const task: EvalTask = {
  id: 'judge-task',
  description: 'Judge whether a response explains the policy.',
  input: { customerId: 'customer-1', message: 'Can I get a refund?' },
  expected: { maxTurns: 1 },
  rubric: [
    {
      id: 'groundedness',
      description: 'The response cites the relevant policy.',
      minimumScore: 0.8,
      requiredSignals: ['policy', 'duplicate'],
    },
  ],
};

const run: AgentRun = {
  output: 'The duplicate charge qualifies under the policy.',
  outcome: {},
  transcript: [],
  toolCalls: [],
  metrics: {
    latencyMs: 1,
    inputTokens: 1,
    outputTokens: 1,
    costUsd: 0,
    turns: 1,
  },
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function request(): JudgeRequest {
  const criterion = task.rubric?.[0];
  if (!criterion) throw new Error('Test criterion is missing.');
  return { task, run, criterion };
}

describe('judge providers', () => {
  it('calibrates the offline signal judge against the golden set', async () => {
    const summary = await calibrateJudge(new FakeJudgeProvider());

    expect(summary.examples).toBe(4);
    expect(summary.meanAbsoluteError).toBe(0);
    expect(summary.passed).toBe(true);
  });

  it('marks a signal-free criterion as unknown', async () => {
    const provider = new FakeJudgeProvider();
    const result = await provider.score({
      ...request(),
      criterion: {
        id: 'subjective',
        description: 'Assess the overall response quality.',
        minimumScore: 0.8,
      },
    });

    expect(result.unknown).toBe(true);
    expect(result.confidence).toBe(0);
  });

  it('grades passing, unknown, and absent rubric criteria', async () => {
    const provider = new FakeJudgeProvider();
    const passing = await gradeWithJudge(task, run, provider);
    const unknown = await gradeWithJudge(
      {
        ...task,
        rubric: [
          {
            id: 'subjective',
            description: 'Assess the overall response quality.',
            minimumScore: 0.8,
          },
        ],
      },
      run,
      provider
    );

    expect(passing[0]?.passed).toBe(true);
    expect(passing[0]?.rationale).toContain('Confidence 1.00');
    expect(unknown[0]?.passed).toBe(false);
    expect(unknown[0]?.rationale).toContain('Unknown:');
    const taskWithoutRubric: EvalTask = {
      id: task.id,
      description: task.description,
      input: task.input,
      expected: task.expected,
    };
    await expect(
      gradeWithJudge(taskWithoutRubric, run, provider)
    ).resolves.toEqual([]);
  });

  it('flattens structured outputs before matching signals', async () => {
    const provider = new FakeJudgeProvider();
    const primitive = await provider.score({
      ...request(),
      run: { ...run, output: true },
    });
    const array = await provider.score({
      ...request(),
      run: { ...run, output: ['policy', { result: 'duplicate' }] },
    });

    expect(primitive.score).toBe(0);
    expect(array.score).toBe(1);
  });

  it('rejects empty and malformed judge golden sets', async () => {
    const empty = await temporaryFile('');
    const malformed = await temporaryFile('{"id":"missing-fields"}\n');

    await expect(
      calibrateJudge(new FakeJudgeProvider(), empty)
    ).rejects.toThrow('No judge calibration examples');
    await expect(
      calibrateJudge(new FakeJudgeProvider(), malformed)
    ).rejects.toThrow('Invalid judge calibration record on line 1');
  });

  it('parses a structured OpenAI Responses result', async () => {
    const provider = new OpenAIJudgeProvider({
      apiKey: 'test-key',
      model: 'test-model',
      fetchImpl: () =>
        Promise.resolve(
          Response.json({
            output: [
              {
                content: [
                  {
                    type: 'output_text',
                    text: JSON.stringify({
                      score: 1,
                      confidence: 0.9,
                      rationale: 'Grounded.',
                      unknown: false,
                    }),
                  },
                ],
              },
            ],
          })
        ),
    });

    await expect(provider.score(request())).resolves.toEqual({
      score: 1,
      confidence: 0.9,
      rationale: 'Grounded.',
      unknown: false,
    });
  });

  it('fails closed on malformed structured output', async () => {
    const provider = new OpenAIJudgeProvider({
      apiKey: 'test-key',
      model: 'test-model',
      fetchImpl: () =>
        Promise.resolve(
          Response.json({
            output: [
              { content: [{ type: 'output_text', text: '{"score":2}' }] },
            ],
          })
        ),
    });

    await expect(provider.score(request())).rejects.toThrow(
      'invalid structured score'
    );
  });

  it('parses a structured Anthropic Messages result', async () => {
    const provider = new AnthropicJudgeProvider({
      apiKey: 'test-key',
      model: 'test-model',
      fetchImpl: () =>
        Promise.resolve(
          Response.json({
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  score: 1,
                  confidence: 0.9,
                  rationale: 'Grounded.',
                  unknown: false,
                }),
              },
            ],
          })
        ),
    });

    await expect(provider.score(request())).resolves.toEqual({
      score: 1,
      confidence: 0.9,
      rationale: 'Grounded.',
      unknown: false,
    });
  });

  it('skips thinking blocks when reading the Anthropic text block', async () => {
    const provider = new AnthropicJudgeProvider({
      apiKey: 'test-key',
      model: 'test-model',
      fetchImpl: () =>
        Promise.resolve(
          Response.json({
            content: [
              { type: 'thinking', thinking: 'Considering the policy...' },
              {
                type: 'text',
                text: JSON.stringify({
                  score: 0.5,
                  confidence: 0.4,
                  rationale: 'Partial.',
                  unknown: false,
                }),
              },
            ],
          })
        ),
    });

    await expect(provider.score(request())).resolves.toEqual({
      score: 0.5,
      confidence: 0.4,
      rationale: 'Partial.',
      unknown: false,
    });
  });

  it('fails closed on a malformed Anthropic structured output', async () => {
    const provider = new AnthropicJudgeProvider({
      apiKey: 'test-key',
      model: 'test-model',
      fetchImpl: () =>
        Promise.resolve(
          Response.json({
            content: [{ type: 'text', text: '{"score":2}' }],
          })
        ),
    });

    await expect(provider.score(request())).rejects.toThrow(
      'invalid structured score'
    );
  });

  it('requires a non-empty Anthropic API key', () => {
    expect(
      () => new AnthropicJudgeProvider({ apiKey: '  ', model: 'test-model' })
    ).toThrow('non-empty API key');
  });
});

async function temporaryFile(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'eval-pyramid-judge-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'golden.jsonl');
  await writeFile(path, contents, 'utf8');
  return path;
}
