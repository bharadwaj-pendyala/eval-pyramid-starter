export interface OrderRecord {
  orderId: string;
  customerId: string;
  amount: number;
  ageDays: number;
  duplicateCharge: boolean;
}

export type RefundDecision =
  | { action: 'refund'; policy: 'duplicate-charge' | 'refund-window' }
  | { action: 'escalate'; policy: 'refund-window' };

export function extractOrderId(message: string): string | undefined {
  return /\border\s*(?:number|#)?\s*(\d+)\b/iu.exec(message)?.[1];
}

export function decideRefund(
  order: OrderRecord,
  refundWindowDays: number
): RefundDecision {
  if (order.duplicateCharge) {
    return { action: 'refund', policy: 'duplicate-charge' };
  }
  if (order.ageDays <= refundWindowDays) {
    return { action: 'refund', policy: 'refund-window' };
  }
  return { action: 'escalate', policy: 'refund-window' };
}
