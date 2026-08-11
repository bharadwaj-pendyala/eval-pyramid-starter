import { describe, expect, it } from 'vitest';

import {
  decideRefund,
  extractOrderId,
  type OrderRecord,
} from '../../src/examples/refund-agent/domain.js';

const order: OrderRecord = {
  orderId: '42',
  customerId: 'customer-100',
  amount: 49,
  ageDays: 45,
  duplicateCharge: false,
};

describe('refund policy component', () => {
  it.each([
    ['Refund order 42.', '42'],
    ['Please refund order #77', '77'],
    ['I cannot remember the purchase', undefined],
  ])('extracts an order id from %j', (message, expected) => {
    expect(extractOrderId(message)).toBe(expected);
  });

  it('refunds a duplicate charge even after the normal window', () => {
    expect(decideRefund({ ...order, duplicateCharge: true }, 30)).toEqual({
      action: 'refund',
      policy: 'duplicate-charge',
    });
  });

  it('escalates a non-duplicate charge outside the refund window', () => {
    expect(decideRefund(order, 30)).toEqual({
      action: 'escalate',
      policy: 'refund-window',
    });
  });
});
