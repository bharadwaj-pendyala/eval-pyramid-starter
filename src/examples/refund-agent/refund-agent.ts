import type {
  AgentRun,
  EvalTask,
  JsonValue,
  SystemUnderTest,
  SystemUnderTestFactory,
  ToolCall,
  TranscriptEvent,
  TrialContext,
} from '../../types.js';
import { decideRefund, extractOrderId, type OrderRecord } from './domain.js';
import {
  InMemoryRefundToolGateway,
  type RefundToolGateway,
} from './tool-gateway.js';

export interface RefundAgentFactoryOptions {
  failureEvery?: number;
  tools?: () => RefundToolGateway;
}

export class RefundAgentFactory implements SystemUnderTestFactory {
  readonly #failureEvery: number;
  readonly #tools: () => RefundToolGateway;

  constructor(options: RefundAgentFactoryOptions = {}) {
    this.#failureEvery = options.failureEvery ?? 0;
    this.#tools = options.tools ?? (() => new InMemoryRefundToolGateway());
  }

  create(): Promise<SystemUnderTest> {
    return Promise.resolve(new RefundAgent(this.#tools(), this.#failureEvery));
  }
}

class RefundAgent implements SystemUnderTest {
  readonly #tools: RefundToolGateway;
  readonly #failureEvery: number;
  #injectFailure = false;

  constructor(tools: RefundToolGateway, failureEvery: number) {
    this.#tools = tools;
    this.#failureEvery = failureEvery;
  }

  async run(task: EvalTask, context: TrialContext): Promise<AgentRun> {
    this.#injectFailure =
      this.#failureEvery > 0 &&
      (context.trialIndex + 1) % this.#failureEvery === 0;
    const startedAt = performance.now();
    const calls: ToolCall[] = [];
    await this.#call(calls, 'verify_identity', {
      customerId: task.input.customerId,
    });

    const orderId = extractOrderId(task.input.message);
    if (!orderId) {
      return this.#missingOrder(task, calls, startedAt);
    }

    const order = await this.#call(calls, 'fetch_order', { orderId });
    if (order.customerId !== task.input.customerId) {
      throw new Error('The order does not belong to the verified customer.');
    }

    const policy: 'duplicate-charge' | 'refund-window' = order.duplicateCharge
      ? 'duplicate-charge'
      : 'refund-window';
    const policyRules = await this.#call(calls, 'fetch_policy', {
      policy,
    });
    const decision = decideRefund(order, policyRules.refundWindowDays);
    if (decision.action === 'refund') {
      return this.#refund(
        task,
        calls,
        orderId,
        order.amount,
        decision.policy,
        startedAt
      );
    }
    return this.#escalate(task, calls, orderId, order.amount, startedAt);
  }

  async #missingOrder(
    task: EvalTask,
    calls: ToolCall[],
    startedAt: number
  ): Promise<AgentRun> {
    if (this.#injectFailure) {
      await this.#call(calls, 'process_refund', {
        amount: 10,
        orderId: 'unknown',
      });
      return buildRun(task, calls, {
        output: {
          message: 'A refund was attempted without an order identifier.',
          policyCited: false,
          status: 'error',
        },
        outcome: {
          ticket: { status: 'error' },
          refund: { status: 'attempted' },
        },
        startedAt,
      });
    }

    await this.#call(calls, 'request_order_details', { fields: ['orderId'] });
    return buildRun(task, calls, {
      output: {
        message:
          'Please provide the order identifier so I can locate the purchase before reviewing refund eligibility.',
        policyCited: false,
        status: 'needs-information',
      },
      outcome: {
        ticket: { status: 'waiting-for-customer' },
        refund: { status: 'not-created' },
      },
      startedAt,
    });
  }

  async #refund(
    task: EvalTask,
    calls: ToolCall[],
    orderId: string,
    amount: number,
    policy: 'duplicate-charge' | 'refund-window',
    startedAt: number
  ): Promise<AgentRun> {
    await this.#call(calls, 'process_refund', { amount, orderId });
    if (!this.#injectFailure) {
      await this.#call(calls, 'send_confirmation', { channel: 'email' });
    }
    return buildRun(task, calls, {
      output: {
        message: this.#injectFailure
          ? 'The refund was processed, but confirmation is still pending.'
          : `Under the ${policy} policy, your $${amount} refund was processed and confirmed.`,
        policyCited: true,
        status: this.#injectFailure ? 'pending' : 'resolved',
      },
      outcome: {
        ticket: { status: this.#injectFailure ? 'pending' : 'resolved' },
        refund: { status: 'processed', amount },
      },
      startedAt,
    });
  }

  async #escalate(
    task: EvalTask,
    calls: ToolCall[],
    orderId: string,
    amount: number,
    startedAt: number
  ): Promise<AgentRun> {
    if (this.#injectFailure) {
      await this.#call(calls, 'process_refund', { amount, orderId });
      return buildRun(task, calls, {
        output: {
          message:
            'The refund was processed even though the request is outside the policy window.',
          policyCited: true,
          status: 'resolved',
        },
        outcome: {
          ticket: { status: 'resolved' },
          refund: { status: 'processed' },
        },
        startedAt,
      });
    }

    await this.#call(calls, 'escalate_to_human', {
      reason: 'outside-refund-window',
    });
    return buildRun(task, calls, {
      output: {
        message:
          'The order is outside the refund policy window, so the ticket was escalated for human review.',
        policyCited: true,
        status: 'escalated',
      },
      outcome: {
        ticket: { status: 'escalated' },
        refund: { status: 'not-created' },
      },
      startedAt,
    });
  }

  async #call(
    calls: ToolCall[],
    name: 'verify_identity',
    argumentsValue: { customerId: string }
  ): Promise<void>;
  async #call(
    calls: ToolCall[],
    name: 'fetch_order',
    argumentsValue: { orderId: string }
  ): Promise<OrderRecord>;
  async #call(
    calls: ToolCall[],
    name: 'fetch_policy',
    argumentsValue: { policy: 'duplicate-charge' | 'refund-window' }
  ): Promise<{ refundWindowDays: number }>;
  async #call(
    calls: ToolCall[],
    name: 'process_refund',
    argumentsValue: { amount: number; orderId: string }
  ): Promise<void>;
  async #call(
    calls: ToolCall[],
    name: 'send_confirmation',
    argumentsValue: { channel: 'email' }
  ): Promise<void>;
  async #call(
    calls: ToolCall[],
    name: 'escalate_to_human',
    argumentsValue: { reason: 'outside-refund-window' }
  ): Promise<void>;
  async #call(
    calls: ToolCall[],
    name: 'request_order_details',
    argumentsValue: { fields: ['orderId'] }
  ): Promise<void>;
  async #call(
    calls: ToolCall[],
    name: string,
    argumentsValue: Record<string, JsonValue>
  ): Promise<unknown> {
    calls.push({ name, arguments: argumentsValue });
    switch (name) {
      case 'verify_identity':
        return this.#tools.verifyIdentity(
          argumentsValue['customerId'] as string
        );
      case 'fetch_order':
        return this.#tools.fetchOrder(argumentsValue['orderId'] as string);
      case 'fetch_policy':
        return this.#tools.fetchPolicy(
          argumentsValue['policy'] as 'duplicate-charge' | 'refund-window'
        );
      case 'process_refund':
        return this.#tools.processRefund(
          argumentsValue['orderId'] as string,
          argumentsValue['amount'] as number
        );
      case 'send_confirmation':
        return this.#tools.sendConfirmation('email');
      case 'escalate_to_human':
        return this.#tools.escalateToHuman('outside-refund-window');
      case 'request_order_details':
        return this.#tools.requestOrderDetails(['orderId']);
      default:
        throw new Error(`Unknown refund tool: ${name}`);
    }
  }
}

interface RunResult {
  output: JsonValue;
  outcome: JsonValue;
  startedAt: number;
}

function buildRun(
  task: EvalTask,
  toolCalls: ToolCall[],
  result: RunResult
): AgentRun {
  const transcript: TranscriptEvent[] = [
    { role: 'user', content: task.input.message },
    ...toolCalls.flatMap((call): TranscriptEvent[] => [
      { role: 'assistant', content: `Calling ${call.name}`, toolCall: call },
      { role: 'tool', content: `${call.name} completed` },
    ]),
    { role: 'assistant', content: outputText(result.output) },
  ];
  return {
    output: result.output,
    outcome: result.outcome,
    transcript,
    toolCalls,
    metrics: {
      latencyMs: Math.max(1, Math.round(performance.now() - result.startedAt)),
      inputTokens: 180,
      outputTokens: 72,
      costUsd: 0,
      turns: toolCalls.length + 1,
    },
  };
}

function outputText(output: JsonValue): string {
  if (typeof output === 'object' && output !== null && !Array.isArray(output)) {
    const message = output['message'];
    if (typeof message === 'string') return message;
  }
  return JSON.stringify(output);
}
