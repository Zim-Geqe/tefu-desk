import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { PayPalClient, paypalApprovalUrl } from '../src/paypal.js';

describe('PayPal HTTP adapter', () => {
  it('accepts both PayPal approval link relations', () => {
    expect(paypalApprovalUrl([{ rel: 'approve', href: 'https://sandbox.paypal.test/approve' }])).toBe('https://sandbox.paypal.test/approve');
    expect(paypalApprovalUrl([{ rel: 'payer-action', href: 'https://sandbox.paypal.test/payer-action' }])).toBe('https://sandbox.paypal.test/payer-action');
    expect(paypalApprovalUrl([{ rel: 'self', href: 'https://sandbox.paypal.test/order' }])).toBeUndefined();
    expect(paypalApprovalUrl([{ rel: 'approve', href: '' }])).toBeUndefined();
  });

  it('uses configured sandbox, OAuth and server credentials', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 'server-token' }), { status: 200 });
      return new Response(JSON.stringify({ id: 'ORDER_ID' }), { status: 201 });
    }) as typeof fetch;
    const config = loadConfig({ DATABASE_URL: 'postgresql://test:test@localhost/test', NODE_ENV: 'test', PAYPAL_CLIENT_ID: 'client', PAYPAL_CLIENT_SECRET: 'secret' });
    const client = new PayPalClient(config, fetcher);
    const response = await client.request('/v2/checkout/orders', 'POST', { intent: 'CAPTURE' }, 'attempt-1');
    expect(response.id).toBe('ORDER_ID');
    expect(calls[0].url).toContain('api-m.sandbox.paypal.com');
    expect(calls[1].init?.headers).toMatchObject({ authorization: 'Bearer server-token', 'paypal-request-id': 'attempt-1' });
  });

  it('verifies webhook signatures through the PayPal verification API', async () => {
    const bodies: unknown[] = [];
    const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
      if (String(input).endsWith('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 'server-token' }), { status: 200 });
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 });
    }) as typeof fetch;
    const config = loadConfig({ DATABASE_URL: 'postgresql://test:test@localhost/test', NODE_ENV: 'test', PAYPAL_CLIENT_ID: 'client', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_WEBHOOK_ID: 'webhook-1' });
    const client = new PayPalClient(config, fetcher);
    const event = { id: 'event-1', event_type: 'PAYMENT.CAPTURE.COMPLETED' };
    const verified = await client.verifyWebhook({ 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.paypal.com/cert', 'paypal-transmission-id': 'transmission-1', 'paypal-transmission-sig': 'signature', 'paypal-transmission-time': '2026-11-07T00:00:00Z' }, event);
    expect(verified).toBe(true);
    expect(bodies[0]).toMatchObject({ webhook_id: 'webhook-1', webhook_event: event, transmission_id: 'transmission-1' });
  });
});
