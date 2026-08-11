import type {
  EvalTask,
  JsonValue,
  SystemRun,
  SystemUnderTest,
  ToolCall,
  TranscriptEvent,
} from '../../types.js';
import { decideRefund, extractOrderId, type OrderRecord } from './domain.js';
import type { RefundToolGateway } from './tool-gateway.js';

export class RefundAgent implements SystemUnderTest {
  readonly #tools: RefundToolGateway;

  constructor(tools: RefundToolGateway) {
    this.#tools = tools;
  }

  async run(task: EvalTask): Promise<SystemRun> {
    const input = refundInput(task.input);
    const calls: ToolCall[] = [];
    await this.#call(calls, 'verify_identity', {
      customerId: input.customerId,
    });

    const orderId = extractOrderId(input.message);
    if (!orderId) return this.#missingOrder(input.message, calls);

    const order = await this.#call(calls, 'fetch_order', { orderId });
    if (order.customerId !== input.customerId) {
      throw new Error('The order does not belong to the verified customer.');
    }

    const policy: 'duplicate-charge' | 'refund-window' = order.duplicateCharge
      ? 'duplicate-charge'
      : 'refund-window';
    const policyRules = await this.#call(calls, 'fetch_policy', { policy });
    const decision = decideRefund(order, policyRules.refundWindowDays);
    if (decision.action === 'refund') {
      return this.#refund(
        input.message,
        calls,
        orderId,
        order.amount,
        decision.policy
      );
    }
    return this.#escalate(input.message, calls);
  }

  async #missingOrder(message: string, calls: ToolCall[]): Promise<SystemRun> {
    await this.#call(calls, 'request_order_details', { fields: ['orderId'] });
    return buildRun(message, calls, {
      message:
        'Please provide the order identifier so I can locate the purchase before reviewing refund eligibility.',
      policyCited: false,
      status: 'needs-information',
    });
  }

  async #refund(
    message: string,
    calls: ToolCall[],
    orderId: string,
    amount: number,
    policy: 'duplicate-charge' | 'refund-window'
  ): Promise<SystemRun> {
    await this.#call(calls, 'process_refund', { amount, orderId });
    await this.#call(calls, 'send_confirmation', { channel: 'email' });
    return buildRun(message, calls, {
      message: `Under the ${policy} policy, your $${amount} refund was processed and confirmed.`,
      policyCited: true,
      status: 'resolved',
    });
  }

  async #escalate(message: string, calls: ToolCall[]): Promise<SystemRun> {
    await this.#call(calls, 'escalate_to_human', {
      reason: 'outside-refund-window',
    });
    return buildRun(message, calls, {
      message:
        'The order is outside the refund policy window, so the ticket was escalated for human review.',
      policyCited: true,
      status: 'escalated',
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

function refundInput(input: { [key: string]: JsonValue }): {
  customerId: string;
  message: string;
} {
  const customerId = input['customerId'];
  const message = input['message'];
  if (typeof customerId !== 'string' || typeof message !== 'string') {
    throw new Error(
      'The refund example requires string input fields customerId and message.'
    );
  }
  return { customerId, message };
}

function buildRun(
  userMessage: string,
  toolCalls: ToolCall[],
  output: { [key: string]: JsonValue }
): SystemRun {
  const transcript: TranscriptEvent[] = [
    { role: 'user', content: userMessage },
    ...toolCalls.flatMap((call): TranscriptEvent[] => [
      { role: 'assistant', content: `Calling ${call.name}`, toolCall: call },
      { role: 'tool', content: `${call.name} completed` },
    ]),
    { role: 'assistant', content: outputText(output) },
  ];
  return {
    output,
    transcript,
    metrics: {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      turns: toolCalls.length + 1,
      usageSource: 'example-rule-agent:no-model-provider',
    },
  };
}

function outputText(output: { [key: string]: JsonValue }): string {
  const message = output['message'];
  return typeof message === 'string' ? message : JSON.stringify(output);
}
