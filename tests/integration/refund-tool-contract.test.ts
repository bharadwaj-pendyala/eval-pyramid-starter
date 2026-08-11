import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { RefundAgentFactory } from '../../src/examples/refund-agent/refund-agent.js';
import { HttpRefundToolGateway } from '../../src/examples/refund-agent/tool-gateway.js';
import { runSuite } from '../../src/harness/run-suite.js';
import { loadTasks } from '../../src/loaders/tasks.js';

const observedRequests: Array<{ path: string; body: unknown }> = [];
const server = setupServer(
  http.post('http://refund-tools.test/identity/verify', async ({ request }) => {
    observedRequests.push({
      path: '/identity/verify',
      body: await request.json(),
    });
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('http://refund-tools.test/orders/:orderId', ({ params }) => {
    observedRequests.push({
      path: `/orders/${String(params['orderId'])}`,
      body: null,
    });
    return HttpResponse.json({
      orderId: '42',
      customerId: 'customer-100',
      amount: 49,
      ageDays: 45,
      duplicateCharge: true,
    });
  }),
  http.get('http://refund-tools.test/policies/:policy', ({ params }) => {
    observedRequests.push({
      path: `/policies/${String(params['policy'])}`,
      body: null,
    });
    return HttpResponse.json({ refundWindowDays: 30 });
  }),
  http.post('http://refund-tools.test/refunds', async ({ request }) => {
    observedRequests.push({ path: '/refunds', body: await request.json() });
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('http://refund-tools.test/confirmations', async ({ request }) => {
    observedRequests.push({
      path: '/confirmations',
      body: await request.json(),
    });
    return new HttpResponse(null, { status: 204 });
  })
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  observedRequests.length = 0;
  server.resetHandlers();
});
afterAll(() => server.close());

describe('refund tool boundary', () => {
  it('runs one eval scenario across the real HTTP client contract', async () => {
    const reportDirectory = await mkdtemp(
      join(tmpdir(), 'eval-tool-contract-')
    );
    const tasks = await loadTasks('evals/tasks.jsonl');
    const task = tasks.find((candidate) => candidate.id === 'eligible-refund');
    if (!task) throw new Error('The eligible-refund fixture is missing.');

    try {
      const result = await runSuite({
        tasks: [task],
        factory: new RefundAgentFactory({
          tools: () => new HttpRefundToolGateway('http://refund-tools.test'),
        }),
        trials: 1,
        k: 1,
        concurrency: 1,
        thresholds: {
          deterministicPassRate: 1,
          passAt1: 1,
          passPowerK: 1,
          judgeAverage: 1,
        },
        reportDirectory,
        runId: 'http-contract',
      });

      expect(result.records[0]?.passed).toBe(true);
      expect(observedRequests).toEqual([
        {
          path: '/identity/verify',
          body: { customerId: 'customer-100' },
        },
        { path: '/orders/42', body: null },
        { path: '/policies/duplicate-charge', body: null },
        { path: '/refunds', body: { amount: 49, orderId: '42' } },
        { path: '/confirmations', body: { channel: 'email' } },
      ]);
    } finally {
      await rm(reportDirectory, { recursive: true, force: true });
    }
  });
});
