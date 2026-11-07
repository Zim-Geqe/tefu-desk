import { api, Checkout, Order, Reconciliation } from './api';

export function createPayPalCheckout(workspaceId: string, orderId: string, idempotencyKey: string) {
  return api<Checkout>(`/workspaces/${encodeURIComponent(workspaceId)}/orders/${encodeURIComponent(orderId)}/paypal-checkout`, { method: 'POST', body: JSON.stringify({ idempotencyKey }) });
}
export async function verifyPayPalReturn(workspaceId: string, attemptId: string, orderId: string) {
  const capture = await api<{status:string;paymentAttemptId:string}>(`/workspaces/${encodeURIComponent(workspaceId)}/payment-attempts/${encodeURIComponent(attemptId)}/capture`, { method: 'POST' });
  const order = await api<Order>(`/workspaces/${encodeURIComponent(workspaceId)}/orders/${encodeURIComponent(orderId)}`);
  return { verified: capture.status === 'CAPTURED' && order.status === 'PAID', status: capture.status, order };
}

export function reconcilePayPalReturn(workspaceId: string, attemptId: string) {
  return api<Reconciliation>(`/workspaces/${encodeURIComponent(workspaceId)}/payment-attempts/${encodeURIComponent(attemptId)}/reconcile`, { method: 'POST' });
}
