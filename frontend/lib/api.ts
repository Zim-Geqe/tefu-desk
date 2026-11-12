const base = (process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3000/api/v1').replace(/\/$/, '');
export type User = { id: string; email: string; name: string; memberships: { role: string; workspace: { id: string; name: string } }[] };
export type Product = { id: string; name: string; description: string | null; sku: string | null; priceMinor: number; currency: string; active: boolean };
export type Item = { id: string; productId?: string | null; descriptionSnapshot: string; quantity: number; unitPriceMinor: number; lineTotalMinor: number; currency: string };
export type Refund = { id: string; paypalRefundId: string; amountMinor: number; currency: string; status: string; createdAt: string; updatedAt: string };
export type Payment = { id: string; status: string; amountMinor: number; currency: string; paypalOrderId?: string | null; captureId?: string | null; createdAt: string; updatedAt?: string; refunds?: Refund[] };
export type OrderActivity = { id: string; action: string; entityType: string | null; entityId: string | null; createdAt: string };
export type Order = { id: string; reference: string; customerName: string; customerEmail?: string | null; customerPhone?: string | null; customerRequest?: string | null; currency: string; subtotalMinor: number; totalMinor: number; status: string; aiGenerated: boolean; confirmedAt?: string | null; confirmedById?: string | null; createdAt: string; items: Item[]; payments?: Payment[]; activity?: OrderActivity[] };
export type PageOrders = { data: Order[]; nextCursor: string | null };
export type Business = { name: string; currency: string; email?: string | null; phone?: string | null; address?: string | null };
export type Dashboard = { ordersByStatus: Record<string, number>; capturedPayments: { totalMinor: number; count: number }; completedRefunds: { totalMinor: number; count: number }; netPaidMinor: number; paymentAttemptsByStatus: Record<string, { count: number; totalMinor: number }>; awaitingPayments: { count: number; totalMinor: number }; awaitingPaymentOrders: number; recentActivity: { action: string; entityType: string | null; entityId: string | null; createdAt: string }[] };
export type AiSettings = { configured: boolean; provider: string; model: string | null; workspaceProvider: string; workspaceModel: string | null };
export type PaypalSettings = { environment: 'sandbox' | 'live'; configured: boolean; supportedCurrencies: string[] };
export type AiDraft = { draft: Order | null; items: { productId: string; quantity: number; matchNote: string }[]; questions: string[]; explanation: string; requiresConfirmation: boolean };
export type Checkout = { paymentAttemptId: string; paypalOrderId?: string; approvalUrl?: string; reused?: boolean; environment?: string; status?: string; reconciliationRequired?: boolean };
export type Reconciliation = { paymentAttemptId: string; status: string; approvalUrl?: string; paypalOrderId?: string };
export type Followup = { text: string; delivery: 'not_sent'; paymentAttempts: { status: string; amountMinor: number; currency: string }[] };
export class ApiError extends Error { status: number; requestId?: string; constructor(message: string, status: number, requestId?: string) { super(message); this.status = status; this.requestId = requestId; } }
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, { ...init, credentials: 'include', headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers } });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (response.status === 401 && !/^\/auth\/(login|register|logout|me)$/.test(path) && typeof window !== 'undefined') window.dispatchEvent(new Event('tefo:session-expired'));
  if (!response.ok) throw new ApiError(data?.error || `Request failed (${response.status})`, response.status, data?.requestId);
  return data as T;
}
export const ws = (id: string) => `/workspaces/${encodeURIComponent(id)}`;
export const money = (minor: number, currency: string) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency, currencyDisplay: 'code' }).format(minor / 100);
export const date = (value: string) => new Intl.DateTimeFormat('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
