import type { OrderRecord } from './domain.js';

export interface RefundToolGateway {
  verifyIdentity(customerId: string): Promise<void>;
  fetchOrder(orderId: string): Promise<OrderRecord>;
  fetchPolicy(
    policy: 'duplicate-charge' | 'refund-window'
  ): Promise<{ refundWindowDays: number }>;
  processRefund(orderId: string, amount: number): Promise<void>;
  sendConfirmation(channel: 'email'): Promise<void>;
  escalateToHuman(reason: 'outside-refund-window'): Promise<void>;
  requestOrderDetails(fields: ['orderId']): Promise<void>;
}

export interface HttpRefundToolGatewayOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class HttpRefundToolGateway implements RefundToolGateway {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(baseUrl: string, options: HttpRefundToolGatewayOptions = {}) {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Refund tool URL must use HTTP or HTTPS.');
    }
    this.#baseUrl = parsed.toString().replace(/\/$/u, '');
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async verifyIdentity(customerId: string): Promise<void> {
    await this.#post('/identity/verify', { customerId });
  }

  async fetchOrder(orderId: string): Promise<OrderRecord> {
    const value = await this.#request(`/orders/${encodeURIComponent(orderId)}`);
    if (!isOrderRecord(value)) {
      throw new Error(
        'Tool response for fetch_order failed runtime validation.'
      );
    }
    return value;
  }

  async fetchPolicy(
    policy: 'duplicate-charge' | 'refund-window'
  ): Promise<{ refundWindowDays: number }> {
    const value = await this.#request(`/policies/${policy}`);
    if (!isRecord(value) || !isNonNegativeNumber(value['refundWindowDays'])) {
      throw new Error(
        'Tool response for fetch_policy failed runtime validation.'
      );
    }
    return { refundWindowDays: value['refundWindowDays'] };
  }

  async processRefund(orderId: string, amount: number): Promise<void> {
    await this.#post('/refunds', { amount, orderId });
  }

  async sendConfirmation(channel: 'email'): Promise<void> {
    await this.#post('/confirmations', { channel });
  }

  async escalateToHuman(reason: 'outside-refund-window'): Promise<void> {
    await this.#post('/escalations', { reason });
  }

  async requestOrderDetails(fields: ['orderId']): Promise<void> {
    await this.#post('/information-requests', { fields });
  }

  async #post(path: string, body: object): Promise<void> {
    await this.#request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async #request(path: string, init?: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `Tool request ${path} failed with HTTP ${response.status}${detail ? `: ${detail.trim()}` : '.'}`
        );
      }
      if (response.status === 204) return undefined;
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        throw new Error(`Tool response ${path} was not JSON.`);
      }
      return await response.json();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(
          `Tool request ${path} timed out after ${this.#timeoutMs} ms.`,
          { cause: error }
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isOrderRecord(value: unknown): value is OrderRecord {
  return (
    isRecord(value) &&
    typeof value['orderId'] === 'string' &&
    typeof value['customerId'] === 'string' &&
    isPositiveNumber(value['amount']) &&
    isNonNegativeNumber(value['ageDays']) &&
    typeof value['duplicateCharge'] === 'boolean'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
