import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { PayPalClient } from '../src/paypal.js';

const url = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!url);

integration('PostgreSQL API integration and tenant isolation', () => {
  let db: PrismaClient;
  let app: FastifyInstance;
  let cookieA: string;
  let cookieB: string;
  let workspaceA: string;
  let workspaceB: string;
  let workspaceC: string;
  let orderA: string;
  let productA: string;
  let emailB: string;
  let emailA: string;
  let emailC: string;
  const paypalOrders = new Map<string, any>();
  const refundDetails = new Map<string, any>();
  let captureStatus = 'COMPLETED';
  let firstPaypalOrderId = '';
  let createCalls = 0;
  let captureCalls = 0;
  let failNextCreateResponse = false;
  let failNextOrderLookup = false;
  const idempotentOrderIds = new Map<string, string>();

  beforeAll(async () => {
    const fakePaypal = {
      request: async (path: string, method: string, payload?: any, requestId?: string) => {
        if (path === '/v2/checkout/orders' && method === 'POST') {
          if (requestId && idempotentOrderIds.has(requestId)) {
            const existingId = idempotentOrderIds.get(requestId)!;
            return { id: existingId, links: [{ rel: 'approve', href: 'https://sandbox.paypal.test/approve' }] };
          }
          createCalls += 1;
          const id = `PAYPAL_ORDER_INTEGRATION_${createCalls}`;
          paypalOrders.set(id, payload);
          if (requestId) idempotentOrderIds.set(requestId, id);
          if (createCalls === 1) firstPaypalOrderId = id;
          if (failNextCreateResponse) { failNextCreateResponse = false; throw new Error('Simulated response timeout after provider accepted request'); }
          return { id, links: [{ rel: 'approve', href: 'https://sandbox.paypal.test/approve' }] };
        }
        if (path.endsWith('/capture')) {
          captureCalls += 1;
          const id = path.split('/').at(-2)!;
          const purchase = paypalOrders.get(id).purchase_units[0];
          return { purchase_units: [{ reference_id: purchase.reference_id, custom_id: purchase.custom_id, payments: { captures: [{ id: `CAPTURE_${id}`, status: captureStatus, amount: purchase.amount }] } }] };
        }
        if (method === 'GET' && path.includes('/v2/payments/refunds/')) {
          const refundId = path.split('/').at(-1)!;
          if (!refundDetails.has(refundId)) throw new Error('Unknown mocked refund');
          return refundDetails.get(refundId);
        }
        if (method === 'GET' && path.includes('/v2/checkout/orders/')) {
          if (failNextOrderLookup) { failNextOrderLookup = false; throw new Error('Simulated PayPal lookup failure'); }
          const id = path.split('/').at(-1)!;
          const purchase = paypalOrders.get(id).purchase_units[0];
          return { id, status: 'COMPLETED', purchase_units: [{ reference_id: purchase.reference_id, custom_id: purchase.custom_id, amount: purchase.amount, payments: { captures: [{ id: `CAPTURE_${id}`, status: captureStatus, amount: purchase.amount }] } }] };
        }
        throw new Error(`Unexpected mocked PayPal request ${method} ${path}`);
      },
      verifyWebhook: async () => true
    } as unknown as PayPalClient;
    db = new PrismaClient({ datasources: { db: { url } } });
    await db.$connect();
    app = await buildApp(loadConfig({ DATABASE_URL: url!, NODE_ENV: 'test', LOG_LEVEL: 'silent', PAYPAL_CLIENT_ID: 'integration-client', PAYPAL_CLIENT_SECRET: 'integration-secret', PAYPAL_WEBHOOK_ID: 'integration-webhook' }), { db, paypal: fakePaypal });
    await app.ready();
    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ready', database: 'connected' });
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const signup = async (email: string, workspaceName: string) => {
      const response = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, password: 'StrongPass123456', name: 'Integration Owner', workspaceName } });
      expect(response.statusCode).toBe(201);
      return { cookie: response.headers['set-cookie']!.toString().split(';')[0], workspaceId: response.json().workspace.id };
    };
    const a = await signup(`a-${suffix}@example.test`, `Workspace A ${suffix}`);
    emailA = `a-${suffix}@example.test`;
    emailB = `b-${suffix}@example.test`;
    const b = await signup(emailB, `Workspace B ${suffix}`);
    emailC = `c-${suffix}@example.test`;
    const c = await signup(emailC, `Workspace C ${suffix}`);
    cookieA = a.cookie; workspaceA = a.workspaceId;
    cookieB = b.cookie; workspaceB = b.workspaceId;
    workspaceC = c.workspaceId;
    await app.inject({ method: 'PATCH', url: `/api/v1/workspaces/${workspaceA}/business`, headers: { cookie: cookieA }, payload: { currency: 'USD' } });
    const product = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceA}/products`, headers: { cookie: cookieA }, payload: { name: 'Integration tea', description: 'Fresh tea', priceMinor: 1250, currency: 'USD' } });
    expect(product.statusCode).toBe(201);
    productA = product.json().id;
    const order = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceA}/orders`, headers: { cookie: cookieA }, payload: { customer: { name: 'Test Customer' }, items: [{ productId: productA, quantity: 2 }] } });
    expect(order.statusCode).toBe(201);
    orderA = order.json().id;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (db) {
      await db.workspace.deleteMany({ where: { id: { in: [workspaceA, workspaceB, workspaceC].filter(Boolean) } } });
      await db.user.deleteMany({ where: { email: { in: [emailA, emailB, emailC].filter(Boolean) } } });
      await db.$disconnect();
    }
  });

  it('isolates tenant records and preserves order snapshots', async () => {
    const crossTenant = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${workspaceB}/orders/${orderA}`, headers: { cookie: cookieB } });
    expect(crossTenant.statusCode).toBe(404);

    const draftUpdate = await app.inject({ method: 'PATCH', url: `/api/v1/workspaces/${workspaceA}/orders/${orderA}`, headers: { cookie: cookieA }, payload: { customer: { name: 'Updated Test Customer' } } });
    expect(draftUpdate.statusCode).toBe(200);
    expect(draftUpdate.json().customerName).toBe('Updated Test Customer');
    await app.inject({ method: 'PATCH', url: `/api/v1/workspaces/${workspaceA}/products/${productA}`, headers: { cookie: cookieA }, payload: { name: 'Renamed tea', priceMinor: 2000 } });
    const persisted = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${workspaceA}/orders/${orderA}`, headers: { cookie: cookieA } });
    expect(persisted.statusCode).toBe(200);
    expect(persisted.json().totalMinor).toBe(2500);
    expect(persisted.json().items[0].descriptionSnapshot).toContain('Integration tea');

    const confirmed = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceA}/orders/${orderA}/confirm`, headers: { cookie: cookieA } });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().confirmedById).toBeTruthy();
    expect(confirmed.json().confirmedAt).toBeTruthy();
    const dashboard = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${workspaceA}/dashboard`, headers: { cookie: cookieA } });
    expect(dashboard.json().awaitingPayments).toEqual({ count: 1, totalMinor: 2500 });
  });

  it('revalidates workspace membership before allowing tenant routes', async () => {
    const noMembership = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${workspaceA}/orders`, headers: { cookie: cookieB } });
    expect(noMembership.statusCode).toBe(404);
    const paypalSettings = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${workspaceA}/settings/paypal`, headers: { cookie: cookieA } });
    expect(paypalSettings.statusCode).toBe(200);
    expect(paypalSettings.json().supportedCurrencies).toContain('USD');
    expect(paypalSettings.json().supportedCurrencies).not.toContain('ZAR');
    expect(Object.keys(paypalSettings.json()).sort()).toEqual(['configured','environment','supportedCurrencies']);
  });

  it('logs in, invalidates the session at logout, and supports creating another workspace', async () => {
    const badLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: emailC, password: 'WrongPassword123' } });
    expect(badLogin.statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: emailC, password: 'StrongPass123456' } });
    expect(login.statusCode).toBe(200);
    const loginCookie = login.headers['set-cookie']!.toString().split(';')[0];
    const secondWorkspace = await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers: { cookie: loginCookie }, payload: { name: 'Additional Workspace', currency: 'USD' } });
    expect(secondWorkspace.statusCode).toBe(201);
    const userC = await db.user.findUniqueOrThrow({ where: { email: emailC } });
    const membership = await db.membership.findUnique({ where: { userId_workspaceId: { userId: userC.id, workspaceId: secondWorkspace.json().id } } });
    expect(membership?.role).toBe('OWNER');
    const logout = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: loginCookie } });
    expect(logout.statusCode).toBe(200);
    const afterLogout = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: loginCookie } });
    expect(afterLogout.statusCode).toBe(401);
    await db.workspace.delete({ where: { id: secondWorkspace.json().id } });
  });

  it('lets an owner add a registered member without granting owner privileges', async () => {
    const added = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceA}/members`, headers: { cookie: cookieA }, payload: { email: emailB, role: 'MEMBER' } });
    expect(added.statusCode).toBe(201);
    expect(added.json().role).toBe('MEMBER');
    const memberAccess = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${workspaceA}/orders`, headers: { cookie: cookieB } });
    expect(memberAccess.statusCode).toBe(200);
    const escalation = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceA}/members`, headers: { cookie: cookieB }, payload: { email: emailA, role: 'ADMIN' } });
    expect(escalation.statusCode).toBe(403);
  });

  it('keeps checkout idempotent and captures only the verified matching amount', async () => {
    const checkout = () => app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceA}/orders/${orderA}/paypal-checkout`, headers: { cookie: cookieA }, payload: { idempotencyKey: 'integration-checkout-key-1' } });
    const first = await checkout();
    expect(first.statusCode).toBe(200);
    expect(first.json().approvalUrl).toBe('https://sandbox.paypal.test/approve');
    expect(paypalOrders.get(firstPaypalOrderId).purchase_units[0].amount.breakdown.item_total).toEqual({ currency_code: 'USD', value: '25.00' });
    const duplicate = await checkout();
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().paymentAttemptId).toBe(first.json().paymentAttemptId);
    expect(createCalls).toBe(1);
    const captured = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceA}/payment-attempts/${first.json().paymentAttemptId}/capture`, headers: { cookie: cookieA } });
    expect(captured.statusCode).toBe(200);
    expect(captured.json().status).toBe('CAPTURED');
    const replay = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceA}/payment-attempts/${first.json().paymentAttemptId}/capture`, headers: { cookie: cookieA } });
    expect(replay.json().status).toBe('CAPTURED');
    expect(captureCalls).toBe(1);
    expect((await db.order.findUniqueOrThrow({ where: { id: orderA } })).status).toBe('PAID');
  });

  it('records denied capture and allows a fresh idempotent attempt', async () => {
    const created = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceA}/orders`, headers: { cookie: cookieA }, payload: { customer: { name: 'Retry Customer' }, items: [{ productId: productA, quantity: 1 }] } });
    const orderId = created.json().id;
    await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceA}/orders/${orderId}/confirm`, headers: { cookie: cookieA } });
    const checkout = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceA}/orders/${orderId}/paypal-checkout`, headers: { cookie: cookieA }, payload: { idempotencyKey: 'integration-denied-key-1' } });
    captureStatus = 'DENIED';
    const capture = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceA}/payment-attempts/${checkout.json().paymentAttemptId}/capture`, headers: { cookie: cookieA } });
    expect(capture.json().status).toBe('DENIED');
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('PAYMENT_FAILED');
    const retry = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceA}/orders/${orderId}/paypal-checkout`, headers: { cookie: cookieA }, payload: { idempotencyKey: 'integration-denied-key-2' } });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().paymentAttemptId).not.toBe(checkout.json().paymentAttemptId);
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('AWAITING_PAYMENT');
    captureStatus = 'COMPLETED';
  });

  it('returns a reconciliation handle after an uncertain PayPal create response', async () => {
    const created = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceA}/orders`, headers: { cookie: cookieA }, payload: { customer: { name: 'Uncertain Customer' }, items: [{ productId: productA, quantity: 1 }] } });
    const orderId = created.json().id;
    await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceA}/orders/${orderId}/confirm`, headers: { cookie: cookieA } });
    failNextCreateResponse = true;
    const checkout = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceA}/orders/${orderId}/paypal-checkout`, headers: { cookie: cookieA }, payload: { idempotencyKey: 'integration-uncertain-create-key' } });
    expect(checkout.statusCode).toBe(202);
    expect(checkout.json().reconciliationRequired).toBe(true);
    const reconciled = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceA}/payment-attempts/${checkout.json().paymentAttemptId}/reconcile`, headers: { cookie: cookieA } });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json().status).toBe('CREATED');
    expect(reconciled.json().approvalUrl).toBeTruthy();
  });

  it('rejects unsupported ZAR checkout before recording a payment attempt', async () => {
    const product = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceB}/products`, headers: { cookie: cookieB }, payload: { name: 'ZAR integration item', priceMinor: 500, currency: 'ZAR' } });
    const order = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceB}/orders`, headers: { cookie: cookieB }, payload: { customer: { name: 'ZAR Customer' }, items: [{ productId: product.json().id, quantity: 1 }] } });
    await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceB}/orders/${order.json().id}/confirm`, headers: { cookie: cookieB } });
    const before = await db.paymentAttempt.count({ where: { orderId: order.json().id } });
    const checkout = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceB}/orders/${order.json().id}/paypal-checkout`, headers: { cookie: cookieB }, payload: { idempotencyKey: 'integration-zar-checkout-key' } });
    expect(checkout.statusCode).toBe(400);
    expect(checkout.json().error).toContain('does not support ZAR');
    expect(await db.paymentAttempt.count({ where: { orderId: order.json().id } })).toBe(before);
  });

  it('tracks verified partial and full refunds and reports the net paid total', async () => {
    const created = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceA}/orders`, headers: { cookie: cookieA }, payload: { customer: { name: 'Refund Customer' }, items: [{ productId: productA, quantity: 1 }] } });
    const orderId = created.json().id;
    await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceA}/orders/${orderId}/confirm`, headers: { cookie: cookieA } });
    const checkout = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceA}/orders/${orderId}/paypal-checkout`, headers: { cookie: cookieA }, payload: { idempotencyKey: 'integration-refund-checkout-key' } });
    const capture = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceA}/payment-attempts/${checkout.json().paymentAttemptId}/capture`, headers: { cookie: cookieA } });
    expect(capture.json().status).toBe('CAPTURED');
    const paypalOrderId = checkout.json().paypalOrderId as string;
    const captureId = `CAPTURE_${paypalOrderId}`;
    const sendRefund = async (refundId: string, value: string) => {
      refundDetails.set(refundId, { id: refundId, status: 'COMPLETED', amount: { currency_code: 'USD', value } });
      return app.inject({ method: 'POST', url: `/api/v1/paypal/webhook/${workspaceA}`, payload: { id: `event-${refundId}`, event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: refundId, supplementary_data: { related_ids: { order_id: paypalOrderId, capture_id: captureId } } } } });
    };
    expect((await sendRefund('REFUND_PARTIAL', '10.00')).statusCode).toBe(200);
    expect((await db.paymentAttempt.findUniqueOrThrow({ where: { id: checkout.json().paymentAttemptId } })).status).toBe('CAPTURED');
    expect((await sendRefund('REFUND_FINAL', '10.00')).statusCode).toBe(200);
    expect((await db.paymentAttempt.findUniqueOrThrow({ where: { id: checkout.json().paymentAttemptId } })).status).toBe('REFUNDED');
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('REFUNDED');
    const dashboard = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${workspaceA}/dashboard`, headers: { cookie: cookieA } });
    expect(dashboard.json().completedRefunds.totalMinor).toBe(2000);
    expect(dashboard.json().netPaidMinor).toBe(2500);
  });

  it('deduplicates verified PayPal webhook events', async () => {
    const event = { id: 'integration-webhook-event-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: `CAPTURE_${firstPaypalOrderId}`, supplementary_data: { related_ids: { order_id: firstPaypalOrderId } } } };
    const send = () => app.inject({ method: 'POST', url: `/api/v1/paypal/webhook/${workspaceA}`, payload: event });
    failNextOrderLookup = true;
    const first = await send();
    expect(first.statusCode).toBe(500);
    const retried = await send();
    expect(retried.statusCode).toBe(200);
    expect(retried.json().duplicate).toBe(false);
    const duplicate = await send();
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().duplicate).toBe(true);
  });
});
