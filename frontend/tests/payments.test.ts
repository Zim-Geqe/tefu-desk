import { describe, expect, it, vi, afterEach } from 'vitest';
import { createPayPalCheckout, reconcilePayPalReturn, verifyPayPalReturn } from '../lib/payments';
describe('PayPal return verification', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('reports success only after capture and order status confirm payment', async () => {
    const mock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({status:'CAPTURED'}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({id:'o1',status:'PAID'}),{status:200}));
    vi.stubGlobal('fetch',mock);
    const result=await verifyPayPalReturn('w1','a1','o1');
    expect(result.verified).toBe(true);expect(mock).toHaveBeenCalledTimes(2);
  });
  it('does not trust a redirect when the authoritative order remains unpaid', async () => {
    const mock=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({status:'UNCERTAIN'}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({id:'o1',status:'AWAITING_PAYMENT'}),{status:200}));
    vi.stubGlobal('fetch',mock);
    expect((await verifyPayPalReturn('w1','a1','o1')).verified).toBe(false);
  });
  it('surfaces backend capture errors without success', async () => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({error:'Capture outcome is uncertain'}),{status:400})));
    await expect(verifyPayPalReturn('w1','a1','o1')).rejects.toThrow('Capture outcome is uncertain');
  });
  it('checks a cancelled checkout with the backend payment reconciliation endpoint', async () => {
    const mock=vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'UNCERTAIN',paymentAttemptId:'a1'}),{status:200}));
    vi.stubGlobal('fetch',mock);
    await expect(reconcilePayPalReturn('w1','a1')).resolves.toMatchObject({status:'UNCERTAIN'});
    expect(String(mock.mock.calls[0][0])).toContain('/payment-attempts/a1/reconcile');
  });
  it('starts checkout with an idempotency key and uses only the backend approval URL', async () => {
    const approvalUrl='https://www.sandbox.paypal.com/checkoutnow?token=backend-order';
    const mock=vi.fn().mockResolvedValue(new Response(JSON.stringify({paymentAttemptId:'a1',paypalOrderId:'pp1',approvalUrl,environment:'sandbox'}),{status:200}));
    vi.stubGlobal('fetch',mock);
    const result=await createPayPalCheckout('w1','o1','checkout-key-123456');
    expect(result.approvalUrl).toBe(approvalUrl);
    expect(JSON.parse(String(mock.mock.calls[0][1]?.body))).toEqual({idempotencyKey:'checkout-key-123456'});
    expect(String(mock.mock.calls[0][0])).toContain('/orders/o1/paypal-checkout');
  });
});
