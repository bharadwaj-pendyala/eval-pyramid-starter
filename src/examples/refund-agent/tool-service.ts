import { mkdir, rename, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import type { JsonValue, ObservedEvidence, ToolCall } from '../../types.js';
import type { EscalationReason, OrderRecord } from './domain.js';

interface RefundRecord {
  orderId: string;
  amount: number;
  status: 'processed';
}

interface RefundToolState {
  verifiedCustomerId: string | null;
  calls: ToolCall[];
  rejectedCalls: ToolCall[];
  refunds: RefundRecord[];
  confirmations: Array<{ channel: 'email' }>;
  escalations: Array<{ reason: EscalationReason }>;
  informationRequests: Array<{ fields: ['orderId'] }>;
}

export interface RefundToolServiceOptions {
  workspace: string;
  orders?: Record<string, OrderRecord>;
  transientRefundFailures?: number;
}

const defaultOrders: Record<string, OrderRecord> = {
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
  '55': {
    orderId: '55',
    customerId: 'customer-300',
    amount: 120,
    ageDays: 3,
    duplicateCharge: true,
  },
};

export class RefundToolService {
  readonly baseUrl: string;
  readonly stateFile: string;
  readonly #server: Server;
  readonly #orders: Record<string, OrderRecord>;
  readonly #state: RefundToolState;
  #remainingRefundFailures: number;
  #writeSequence = Promise.resolve();

  private constructor(
    server: Server,
    baseUrl: string,
    stateFile: string,
    orders: Record<string, OrderRecord>,
    transientRefundFailures: number
  ) {
    this.#server = server;
    this.#remainingRefundFailures = transientRefundFailures;
    this.baseUrl = baseUrl;
    this.stateFile = stateFile;
    this.#orders = orders;
    this.#state = {
      verifiedCustomerId: null,
      calls: [],
      rejectedCalls: [],
      refunds: [],
      confirmations: [],
      escalations: [],
      informationRequests: [],
    };
  }

  static async start(
    options: RefundToolServiceOptions
  ): Promise<RefundToolService> {
    await mkdir(options.workspace, { recursive: true });
    const stateFile = join(options.workspace, 'refund-tool-state.json');
    const holder: { current?: RefundToolService } = {};
    const server = createServer((request, response) => {
      if (holder.current) void holder.current.#handle(request, response);
    });
    await listen(server);
    const address = server.address() as AddressInfo;
    const service = new RefundToolService(
      server,
      `http://127.0.0.1:${address.port}`,
      stateFile,
      structuredClone(options.orders ?? defaultOrders),
      options.transientRefundFailures ?? 0
    );
    holder.current = service;
    try {
      await service.#persist();
    } catch (error) {
      await service.close().catch(() => undefined);
      throw error;
    }
    return service;
  }

  observe(): ObservedEvidence {
    const refund = this.#state.refunds.at(-1);
    const ticketStatus = this.#state.informationRequests.length
      ? 'waiting-for-customer'
      : this.#state.escalations.length
        ? 'escalated'
        : refund && this.#state.confirmations.length
          ? 'resolved'
          : refund
            ? 'pending'
            : 'open';
    const outcome: { [key: string]: JsonValue } = {
      ticket: { status: ticketStatus },
      refund: refund
        ? { status: refund.status, amount: refund.amount }
        : { status: 'not-created' },
      refundCount: this.#state.refunds.length,
      confirmationCount: this.#state.confirmations.length,
    };
    return {
      outcome,
      toolCalls: structuredClone(this.#state.calls),
      rejectedToolCalls: structuredClone(this.#state.rejectedCalls),
      source: 'refund-tool-service:persisted-state',
    };
  }

  async close(): Promise<void> {
    try {
      await this.#writeSequence;
    } finally {
      await new Promise<void>((resolve, reject) => {
        this.#server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    let attempt: ToolCall | undefined;
    try {
      const url = new URL(request.url ?? '/', this.baseUrl);
      if (request.method === 'GET' && url.pathname === '/health') {
        json(response, 200, { status: 'ok' });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/evidence') {
        json(response, 200, this.observe());
        return;
      }
      if (request.method === 'POST' && url.pathname === '/identity/verify') {
        const body = await jsonBody(request);
        const customerId = requiredString(body, 'customerId');
        attempt = { name: 'verify_identity', arguments: { customerId } };
        if (!customerId.startsWith('customer-')) {
          throw new HttpError(403, 'Identity verification failed.');
        }
        this.#state.verifiedCustomerId = customerId;
        await this.#record('verify_identity', { customerId });
        noContent(response);
        return;
      }
      const orderMatch = /^\/orders\/([^/]+)$/u.exec(url.pathname);
      if (request.method === 'GET' && orderMatch) {
        const orderId = decodeURIComponent(orderMatch[1] ?? '');
        attempt = { name: 'fetch_order', arguments: { orderId } };
        const order = this.#orders[orderId];
        if (!order) throw new HttpError(404, `Order ${orderId} was not found.`);
        await this.#record('fetch_order', { orderId });
        json(response, 200, order);
        return;
      }
      const policyMatch =
        /^\/policies\/(duplicate-charge|refund-window)$/u.exec(url.pathname);
      if (request.method === 'GET' && policyMatch) {
        const policy = policyMatch[1] as 'duplicate-charge' | 'refund-window';
        await this.#record('fetch_policy', { policy });
        json(response, 200, {
          refundWindowDays: policy === 'refund-window' ? 30 : 0,
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/refunds') {
        const body = await jsonBody(request);
        const orderId = requiredString(body, 'orderId');
        const amount = requiredPositiveNumber(body, 'amount');
        attempt = { name: 'process_refund', arguments: { orderId, amount } };
        const order = this.#orders[orderId];
        if (!order) throw new HttpError(404, `Order ${orderId} was not found.`);
        if (this.#state.verifiedCustomerId !== order.customerId) {
          throw new HttpError(409, 'Verified customer does not own the order.');
        }
        if (amount !== order.amount) {
          throw new HttpError(409, 'Refund amount does not match the order.');
        }
        if (this.#state.refunds.some((item) => item.orderId === orderId)) {
          throw new HttpError(409, 'Refund already exists.');
        }
        if (this.#remainingRefundFailures > 0) {
          this.#remainingRefundFailures -= 1;
          throw new HttpError(
            503,
            'Payment provider is temporarily unavailable.'
          );
        }
        this.#state.refunds.push({ orderId, amount, status: 'processed' });
        await this.#record('process_refund', { orderId, amount });
        noContent(response);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/confirmations') {
        const body = await jsonBody(request);
        const channel = requiredString(body, 'channel');
        attempt = { name: 'send_confirmation', arguments: { channel } };
        if (channel !== 'email') {
          throw new HttpError(400, 'Unsupported confirmation channel.');
        }
        if (this.#state.refunds.length === 0) {
          throw new HttpError(
            409,
            'Cannot confirm a refund that does not exist.'
          );
        }
        this.#state.confirmations.push({ channel });
        await this.#record('send_confirmation', { channel });
        noContent(response);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/escalations') {
        const body = await jsonBody(request);
        const reason = requiredString(body, 'reason');
        attempt = { name: 'escalate_to_human', arguments: { reason } };
        if (!isEscalationReason(reason)) {
          throw new HttpError(400, 'Unsupported escalation reason.');
        }
        this.#state.escalations.push({ reason });
        await this.#record('escalate_to_human', { reason });
        noContent(response);
        return;
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/information-requests'
      ) {
        const body = await jsonBody(request);
        if (!isOrderIdFields(body['fields'])) {
          throw new HttpError(400, 'Unsupported information request.');
        }
        const fields: ['orderId'] = ['orderId'];
        this.#state.informationRequests.push({ fields });
        await this.#record('request_order_details', { fields });
        noContent(response);
        return;
      }
      throw new HttpError(404, 'Not found.');
    } catch (error) {
      if (attempt && error instanceof HttpError) {
        this.#state.rejectedCalls.push(attempt);
        await this.#persist().catch(() => undefined);
      }
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : 'Unknown error';
      json(response, status, { error: message });
    }
  }

  async #record(
    name: string,
    argumentsValue: { [key: string]: JsonValue }
  ): Promise<void> {
    this.#state.calls.push({ name, arguments: argumentsValue });
    await this.#persist();
  }

  #persist(): Promise<void> {
    this.#writeSequence = this.#writeSequence.then(async () => {
      const temporary = `${this.stateFile}.tmp`;
      await writeFile(temporary, `${JSON.stringify(this.#state, null, 2)}\n`);
      await rename(temporary, this.stateFile);
    });
    return this.#writeSequence;
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function jsonBody(
  request: IncomingMessage
): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > 64 * 1024)
      throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
  if (!isRecord(parsed))
    throw new HttpError(400, 'JSON body must be an object.');
  return parsed;
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, `${field} must be a non-empty string.`);
  }
  return value;
}

function requiredPositiveNumber(
  body: Record<string, unknown>,
  field: string
): number {
  const value = body[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new HttpError(400, `${field} must be a positive number.`);
  }
  return value;
}

function isOrderIdFields(value: unknown): value is ['orderId'] {
  return Array.isArray(value) && value.length === 1 && value[0] === 'orderId';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function noContent(response: ServerResponse): void {
  response.writeHead(204).end();
}

function isEscalationReason(value: string): value is EscalationReason {
  return (
    value === 'outside-refund-window' || value === 'order-customer-mismatch'
  );
}
