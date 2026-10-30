import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { HttpRefundToolGateway } from '../../src/examples/refund-agent/tool-gateway.js';
import { RefundToolService } from '../../src/examples/refund-agent/tool-service.js';

describe('refund tool provider boundary', () => {
  it('fails the first refund call when a transient provider fault is set', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'refund-tools-fault-'));
    const service = await RefundToolService.start({
      workspace,
      transientRefundFailures: 1,
    });
    const gateway = new HttpRefundToolGateway(service.baseUrl);

    try {
      await gateway.verifyIdentity('customer-100');
      await expect(gateway.processRefund('42', 49)).rejects.toThrow('HTTP 503');
      await expect(gateway.processRefund('42', 49)).resolves.toBeUndefined();
      expect(service.observe().outcome).toMatchObject({ refundCount: 1 });
    } finally {
      await service.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('crosses a real TCP socket, mutates state, and persists observable evidence', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'refund-tools-'));
    const service = await RefundToolService.start({ workspace });
    const gateway = new HttpRefundToolGateway(service.baseUrl);

    try {
      await gateway.verifyIdentity('customer-100');
      await expect(gateway.fetchOrder('42')).resolves.toMatchObject({
        customerId: 'customer-100',
        amount: 49,
      });
      await expect(gateway.fetchPolicy('duplicate-charge')).resolves.toEqual({
        refundWindowDays: 0,
      });
      await gateway.processRefund('42', 49);
      await gateway.sendConfirmation('email');

      const evidence = service.observe();
      expect(evidence.outcome).toEqual({
        ticket: { status: 'resolved' },
        refund: { status: 'processed', amount: 49 },
        refundCount: 1,
        confirmationCount: 1,
      });
      expect(evidence.toolCalls.map((call) => call.name)).toEqual([
        'verify_identity',
        'fetch_order',
        'fetch_policy',
        'process_refund',
        'send_confirmation',
      ]);
      const persisted = JSON.parse(
        await readFile(service.stateFile, 'utf8')
      ) as {
        refunds: unknown[];
        confirmations: unknown[];
      };
      expect(persisted.refunds).toHaveLength(1);
      expect(persisted.confirmations).toHaveLength(1);
    } finally {
      await service.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('enforces ownership at the provider instead of trusting the agent', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'refund-tools-owner-'));
    const service = await RefundToolService.start({ workspace });
    const gateway = new HttpRefundToolGateway(service.baseUrl);

    try {
      await gateway.verifyIdentity('customer-200');
      await expect(gateway.processRefund('42', 49)).rejects.toThrow(
        'Verified customer does not own the order'
      );
      const evidence = service.observe();
      expect(evidence.outcome).toEqual({
        ticket: { status: 'open' },
        refund: { status: 'not-created' },
        refundCount: 0,
        confirmationCount: 0,
      });
      expect(evidence.toolCalls.map((call) => call.name)).toEqual([
        'verify_identity',
      ]);
      expect(evidence.rejectedToolCalls).toEqual([
        {
          name: 'process_refund',
          arguments: { orderId: '42', amount: 49 },
          position: 1,
        },
      ]);
      await expect(gateway.processRefund('77', 0)).rejects.toThrow();
      expect(service.observe().rejectedToolCalls?.at(-1)).toEqual({
        name: 'process_refund',
        arguments: { orderId: '77', amount: 0 },
        position: 1,
      });
    } finally {
      await service.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects a provider response that violates the runtime contract', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          orderId: '42',
          customerId: 'customer-100',
          amount: '49',
          ageDays: 2,
          duplicateCharge: true,
        })
      );
    });
    const baseUrl = await listen(server);

    try {
      const gateway = new HttpRefundToolGateway(baseUrl);
      await expect(gateway.fetchOrder('42')).rejects.toThrow(
        'failed runtime validation'
      );
    } finally {
      await close(server);
    }
  });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
