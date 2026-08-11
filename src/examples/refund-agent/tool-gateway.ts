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

const demoOrders: Record<string, OrderRecord> = {
  '42': {
    orderId: '42',
    customerId: 'customer-100',
    amount: 49,
    ageDays: 45,
    duplicateCharge: true,
  },
  '77': {
    orderId: '77',
    customerId: 'customer-200',
    amount: 85,
    ageDays: 180,
    duplicateCharge: false,
  },
};

export class InMemoryRefundToolGateway implements RefundToolGateway {
  verifyIdentity(customerId: string): Promise<void> {
    if (!customerId.startsWith('customer-')) {
      return Promise.reject(new Error('Identity verification failed.'));
    }
    return Promise.resolve();
  }

  fetchOrder(orderId: string): Promise<OrderRecord> {
    const order = demoOrders[orderId];
    return order
      ? Promise.resolve(order)
      : Promise.reject(new Error(`Order ${orderId} was not found.`));
  }

  fetchPolicy(
    policy: 'duplicate-charge' | 'refund-window'
  ): Promise<{ refundWindowDays: number }> {
    return Promise.resolve({
      refundWindowDays: policy === 'refund-window' ? 30 : 0,
    });
  }

  processRefund(orderId: string, amount: number): Promise<void> {
    return orderId.length > 0 && amount > 0
      ? Promise.resolve()
      : Promise.reject(new Error('A refund requires an order and amount.'));
  }

  sendConfirmation(channel: 'email'): Promise<void> {
    return channel === 'email'
      ? Promise.resolve()
      : Promise.reject(new Error('Unsupported confirmation channel.'));
  }

  escalateToHuman(reason: 'outside-refund-window'): Promise<void> {
    return reason === 'outside-refund-window'
      ? Promise.resolve()
      : Promise.reject(new Error('Unsupported escalation reason.'));
  }

  requestOrderDetails(fields: ['orderId']): Promise<void> {
    return fields[0] === 'orderId'
      ? Promise.resolve()
      : Promise.reject(new Error('Unsupported information request.'));
  }
}

export class HttpRefundToolGateway implements RefundToolGateway {
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl.replace(/\/$/u, '');
  }

  async verifyIdentity(customerId: string): Promise<void> {
    await this.#post('/identity/verify', { customerId });
  }

  async fetchOrder(orderId: string): Promise<OrderRecord> {
    return this.#request<OrderRecord>(`/orders/${encodeURIComponent(orderId)}`);
  }

  fetchPolicy(
    policy: 'duplicate-charge' | 'refund-window'
  ): Promise<{ refundWindowDays: number }> {
    return this.#request(`/policies/${policy}`);
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

  async #request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.#baseUrl}${path}`, init);
    if (!response.ok) {
      throw new Error(`Tool request ${path} failed with ${response.status}.`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}
