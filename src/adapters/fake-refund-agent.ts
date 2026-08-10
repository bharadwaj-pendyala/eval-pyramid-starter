import type {
  AgentRun,
  EvalTask,
  JsonValue,
  SystemUnderTest,
  SystemUnderTestFactory,
  ToolCall,
  TranscriptEvent,
  TrialContext,
} from '../types.js';

export interface FakeRefundAgentOptions {
  failureEvery?: number;
}

export class FakeRefundAgentFactory implements SystemUnderTestFactory {
  readonly #options: FakeRefundAgentOptions;

  constructor(options: FakeRefundAgentOptions = {}) {
    this.#options = options;
  }

  create(): Promise<SystemUnderTest> {
    return Promise.resolve(new FakeRefundAgent(this.#options));
  }
}

class FakeRefundAgent implements SystemUnderTest {
  readonly #failureEvery: number;

  constructor(options: FakeRefundAgentOptions) {
    this.#failureEvery = options.failureEvery ?? 0;
  }

  run(task: EvalTask, context: TrialContext): Promise<AgentRun> {
    const shouldInjectFailure =
      this.#failureEvery > 0 &&
      (context.trialIndex + 1) % this.#failureEvery === 0;

    if (task.id === 'eligible-refund') {
      return Promise.resolve(this.#eligibleRefund(task, shouldInjectFailure));
    }
    if (task.id === 'ineligible-refund') {
      return Promise.resolve(this.#ineligibleRefund(task, shouldInjectFailure));
    }
    if (task.id === 'missing-order-details') {
      return Promise.resolve(this.#requestDetails(task, shouldInjectFailure));
    }

    return Promise.reject(
      new Error(`The fake adapter has no scenario for task ${task.id}`)
    );
  }

  #eligibleRefund(task: EvalTask, shouldInjectFailure: boolean): AgentRun {
    const toolCalls: ToolCall[] = [
      tool('verify_identity', { customerId: task.input.customerId }),
      tool('fetch_policy', { policy: 'duplicate-charge' }),
      tool('process_refund', { amount: 49, orderId: '42' }),
    ];
    if (!shouldInjectFailure) {
      toolCalls.push(tool('send_confirmation', { channel: 'email' }));
    }

    return buildRun({
      task,
      toolCalls,
      output: {
        message: shouldInjectFailure
          ? 'The duplicate charge was reviewed, but confirmation is still pending.'
          : 'Under the duplicate-charge policy, your $49 refund was processed and confirmed.',
        policyCited: true,
        status: shouldInjectFailure ? 'pending' : 'resolved',
      },
      outcome: {
        ticket: { status: shouldInjectFailure ? 'pending' : 'resolved' },
        refund: { status: 'processed', amount: 49 },
      },
      costUsd: 0.012,
      latencyMs: 320,
    });
  }

  #ineligibleRefund(task: EvalTask, shouldInjectFailure: boolean): AgentRun {
    const toolCalls = [
      tool('verify_identity', { customerId: task.input.customerId }),
      tool('fetch_policy', { policy: 'refund-window' }),
      ...(shouldInjectFailure
        ? [tool('process_refund', { amount: 85, orderId: '77' })]
        : [tool('escalate_to_human', { reason: 'outside-refund-window' })]),
    ];

    return buildRun({
      task,
      toolCalls,
      output: {
        message: shouldInjectFailure
          ? 'The refund was processed even though the request is outside the policy window.'
          : 'The order is outside the refund policy window, so the ticket was escalated for human review.',
        policyCited: true,
        status: shouldInjectFailure ? 'resolved' : 'escalated',
      },
      outcome: {
        ticket: { status: shouldInjectFailure ? 'resolved' : 'escalated' },
        refund: { status: shouldInjectFailure ? 'processed' : 'not-created' },
      },
      costUsd: 0.01,
      latencyMs: 290,
    });
  }

  #requestDetails(task: EvalTask, shouldInjectFailure: boolean): AgentRun {
    const toolCalls = [
      tool('verify_identity', { customerId: task.input.customerId }),
      ...(shouldInjectFailure
        ? [tool('process_refund', { amount: 10, orderId: 'unknown' })]
        : [tool('request_order_details', { fields: ['orderId'] })]),
    ];

    return buildRun({
      task,
      toolCalls,
      output: {
        message: shouldInjectFailure
          ? 'A refund was attempted without an order identifier.'
          : 'Please provide the order identifier so I can locate the purchase before reviewing refund eligibility.',
        policyCited: false,
        status: shouldInjectFailure ? 'error' : 'needs-information',
      },
      outcome: {
        ticket: {
          status: shouldInjectFailure ? 'error' : 'waiting-for-customer',
        },
        refund: { status: shouldInjectFailure ? 'attempted' : 'not-created' },
      },
      costUsd: 0.006,
      latencyMs: 180,
    });
  }
}

interface BuildRunInput {
  task: EvalTask;
  toolCalls: ToolCall[];
  output: JsonValue;
  outcome: JsonValue;
  costUsd: number;
  latencyMs: number;
}

function buildRun(input: BuildRunInput): AgentRun {
  const transcript: TranscriptEvent[] = [
    { role: 'user', content: input.task.input.message },
    ...input.toolCalls.flatMap((call): TranscriptEvent[] => [
      { role: 'assistant', content: `Calling ${call.name}`, toolCall: call },
      { role: 'tool', content: `${call.name} completed` },
    ]),
    { role: 'assistant', content: outputText(input.output) },
  ];

  return {
    output: input.output,
    outcome: input.outcome,
    transcript,
    toolCalls: input.toolCalls,
    metrics: {
      latencyMs: input.latencyMs,
      inputTokens: 180,
      outputTokens: 72,
      costUsd: input.costUsd,
      turns: input.toolCalls.length + 1,
    },
  };
}

function tool(
  name: string,
  argumentsValue: { [key: string]: JsonValue }
): ToolCall {
  return { name, arguments: argumentsValue };
}

function outputText(output: JsonValue): string {
  if (typeof output === 'object' && output !== null && !Array.isArray(output)) {
    const message = output['message'];
    if (typeof message === 'string') return message;
  }
  return JSON.stringify(output);
}
