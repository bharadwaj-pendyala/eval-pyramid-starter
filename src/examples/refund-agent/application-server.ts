import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import type {
  TaskInput,
  JsonValue,
  SystemUnderTest,
  TrialContext,
} from '../../types.js';

export class RefundApplicationServer {
  readonly baseUrl: string;
  readonly #server: Server;
  readonly #system: SystemUnderTest;
  readonly #workspace: string;

  private constructor(
    server: Server,
    baseUrl: string,
    system: SystemUnderTest,
    workspace: string
  ) {
    this.#server = server;
    this.baseUrl = baseUrl;
    this.#system = system;
    this.#workspace = workspace;
  }

  static async start(
    system: SystemUnderTest,
    workspace: string
  ): Promise<RefundApplicationServer> {
    const holder: { current?: RefundApplicationServer } = {};
    const server = createServer((request, response) => {
      if (holder.current) void holder.current.#handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    const application = new RefundApplicationServer(
      server,
      `http://127.0.0.1:${address.port}`,
      system,
      workspace
    );
    holder.current = application;
    return application;
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', this.baseUrl);
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, { status: 'ok' });
        return;
      }
      if (request.method !== 'POST' || url.pathname !== '/run') {
        sendJson(response, 404, { error: 'Not found.' });
        return;
      }
      const body = await readJson(request);
      const input = body['input'];
      const context = body['context'];
      if (!isTaskInput(input) || !isRemoteContext(context)) {
        sendJson(response, 400, { error: 'Invalid run request.' });
        return;
      }
      const trialContext: TrialContext = {
        runId: context.runId,
        trialIndex: context.trialIndex,
        workspace: this.#workspace,
      };
      const result = await this.#system.run(input, trialContext);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}

function isTaskInput(value: unknown): value is TaskInput {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isRemoteContext(
  value: unknown
): value is { runId: string; trialIndex: number } {
  return (
    isRecord(value) &&
    typeof value['runId'] === 'string' &&
    Number.isInteger(value['trialIndex']) &&
    typeof value['trialIndex'] === 'number' &&
    value['trialIndex'] >= 0
  );
}

async function readJson(
  request: IncomingMessage
): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > 1024 * 1024) throw new Error('Run request is too large.');
    chunks.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!isRecord(value)) throw new Error('Run request must be a JSON object.');
  return value;
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown
): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
