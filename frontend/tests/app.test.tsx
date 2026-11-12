import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Home, { VerifiedPaymentRecord } from '../app/page';

const user = { id: 'u1', email: 'owner@example.test', name: 'Tefo Owner', memberships: [{ role: 'OWNER', workspace: { id: 'w1', name: 'Corner Kitchen' } }] };
const product = { id: 'p1', name: 'Chicken meal', description: null, sku: null, priceMinor: 8900, currency: 'ZAR', active: true };
const dashboard = { ordersByStatus: {}, capturedPayments: { totalMinor: 0, count: 0 }, completedRefunds: { totalMinor: 0, count: 0 }, netPaidMinor: 0, paymentAttemptsByStatus: {}, awaitingPayments: { count: 0, totalMinor: 0 }, awaitingPaymentOrders: 0, recentActivity: [] };
function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }); }

function workspaceApi(options: { products?: typeof product[]; aiResponse?: unknown } = {}) {
  let signedIn = false;
  const products = options.products ?? [product];
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method || 'GET';
    if (url.endsWith('/auth/me')) return signedIn ? json(user) : json({ error: 'Authentication required' }, 401);
    if (url.endsWith('/auth/login') && method === 'POST') { signedIn = true; return json({ user, expiresAt: new Date().toISOString() }); }
    if (url.endsWith('/dashboard')) return json(dashboard);
    if (url.endsWith('/products') && method === 'GET') return json(products);
    if (url.endsWith('/orders?limit=25')) return json({ data: [], nextCursor: null });
    if (url.endsWith('/business')) return json({ name: 'Corner Kitchen', currency: 'ZAR' });
    if (url.endsWith('/settings/ai')) return json({ configured: true, provider: 'gemini', model: 'test-model', workspaceProvider: 'GEMINI', workspaceModel: 'test-model' });
    if (url.endsWith('/settings/paypal')) return json({ environment: 'sandbox', configured: false, supportedCurrencies: ['USD', 'EUR'] });
    if (url.endsWith('/orders/draft-from-request') && method === 'POST') return json(options.aiResponse, 201);
    return json({ error: `Unexpected request: ${method} ${url}` }, 404);
  });
}

async function signInAndOpenOrderDesk() {
  render(<Home/>);
  await screen.findByLabelText('Work email');
  fireEvent.change(screen.getByLabelText('Work email'), { target: { value: user.email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'StrongPassword123' } });
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
  await screen.findByText('Your business, in good order');
  fireEvent.click(screen.getByRole('button', { name: 'Order Desk' }));
  await screen.findByText('What did your customer ask for?');
}

describe('Tefo Desk workspace flows', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('signs in, creates a catalogue item, and shows the real AI provider error without fabricating a draft', async () => {
    let signedIn = false;
    let products: typeof product[] = [];
    let business = { name: 'Corner Kitchen', currency: 'ZAR' };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method || 'GET';
      if (url.endsWith('/auth/me')) return signedIn ? json(user) : json({ error: 'Authentication required' }, 401);
      if (url.endsWith('/auth/login') && method === 'POST') { signedIn = true; return json({ user: { id: 'u1', email: user.email, name: user.name }, expiresAt: new Date().toISOString() }); }
      if (url.endsWith('/dashboard')) return json(dashboard);
      if (url.endsWith('/products') && method === 'GET') return json(products);
      if (url.endsWith('/orders?limit=25')) return json({ data: [], nextCursor: null });
      if (url.endsWith('/business') && method === 'GET') return json(business);
      if (url.endsWith('/business') && method === 'PATCH') { business = JSON.parse(String(init?.body)); return json(business); }
      if (url.endsWith('/settings/ai')) return json({ configured: false, provider: 'none', model: null, workspaceProvider: 'NONE', workspaceModel: null });
      if (url.endsWith('/settings/paypal')) return json({ environment: 'sandbox', configured: false, supportedCurrencies: ['USD', 'EUR'] });
      if (url.endsWith('/products') && method === 'POST') { products = [product]; return json(product, 201); }
      if (url.endsWith('/orders/draft-from-request') && method === 'POST') return json({ error: 'AI is disabled for this workspace' }, 503);
      return json({ error: `Unexpected request: ${method} ${url}` }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<Home/>);

    await screen.findByLabelText('Work email');
    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: user.email } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'StrongPassword123' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await screen.findByText('Your business, in good order');
    await screen.findByText('Welcome to Tefo Desk.');
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/auth/login') && init?.credentials === 'include')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Catalogue' }));
    fireEvent.change(screen.getByLabelText('Product or service name'), { target: { value: product.name } });
    fireEvent.change(screen.getByLabelText('Price (ZAR)'), { target: { value: '89.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to catalogue' }));
    await screen.findByText('Chicken meal');
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/products') && init?.method === 'POST')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Order Desk' }));
    fireEvent.change(screen.getByLabelText('Customer name'), { target: { value: 'A customer' } });
    fireEvent.change(screen.getByLabelText('Email (optional)'), { target: { value: 'customer@example.test' } });
    fireEvent.change(screen.getByLabelText('Customer request'), { target: { value: 'One chicken meal' } });
    const composer = screen.getByText('What did your customer ask for?').closest('section')!;
    fireEvent.click(within(composer).getByRole('button', { name: 'Draft with AI' }));
    await screen.findByText('AI is disabled for this workspace');
    expect(screen.queryByText('Review your order draft')).toBeNull();
  });

  it('scrolls the seller to a successfully created AI order draft', async () => {
    const scrollIntoView = vi.fn();
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    try {
      const order = {
        id: 'o1', reference: 'TD-TEST-ORDER', customerName: 'A customer', customerEmail: null, customerPhone: null,
        customerRequest: 'Ke kopa one chicken meal', currency: 'ZAR', subtotalMinor: 8900, totalMinor: 8900,
        status: 'DRAFT', aiGenerated: true, createdAt: new Date().toISOString(),
        items: [{ id: 'i1', productId: product.id, descriptionSnapshot: product.name, quantity: 1, unitPriceMinor: 8900, lineTotalMinor: 8900, currency: 'ZAR' }]
      };
      const fetchMock = workspaceApi({ aiResponse: { draft: order, items: [{ productId: product.id, quantity: 1, matchNote: 'The request asks for one chicken meal.' }], questions: [], explanation: 'Matched the catalog item.', requiresConfirmation: true } });
      vi.stubGlobal('fetch', fetchMock);
      await signInAndOpenOrderDesk();
      fireEvent.change(screen.getByLabelText('Customer name'), { target: { value: 'A customer' } });
      fireEvent.change(screen.getByLabelText('Customer request'), { target: { value: 'Ke kopa one chicken meal' } });
      fireEvent.click(screen.getByRole('button', { name: 'Draft with AI' }));

      expect(await screen.findByText('Review your order draft')).toBeTruthy();
      expect(await screen.findByText(/Server-calculated total/)).toBeTruthy();
      expect(await screen.findByText(/AI match note: The request asks for one chicken meal/)).toBeTruthy();
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' }));
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/orders/draft-from-request'))).toBe(true);
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });

  it('explains when no active catalog product matches the request', async () => {
    const fetchMock = workspaceApi({ aiResponse: { draft: null, items: [], questions: [], explanation: '', requiresConfirmation: true } });
    vi.stubGlobal('fetch', fetchMock);
    await signInAndOpenOrderDesk();
    fireEvent.change(screen.getByLabelText('Customer name'), { target: { value: 'A customer' } });
    fireEvent.change(screen.getByLabelText('Customer request'), { target: { value: 'A product not in the catalogue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Draft with AI' }));

    expect(await screen.findByText(/No active catalogue items matched this request/)).toBeTruthy();
    expect(screen.queryByText('Review your order draft')).toBeNull();
  });

  it('asks the seller to add a product when the active catalogue is empty', async () => {
    const fetchMock = workspaceApi({ products: [] });
    vi.stubGlobal('fetch', fetchMock);
    await signInAndOpenOrderDesk();
    fireEvent.change(screen.getByLabelText('Customer name'), { target: { value: 'A customer' } });
    fireEvent.change(screen.getByLabelText('Customer request'), { target: { value: 'One item' } });
    fireEvent.click(screen.getByRole('button', { name: 'Draft with AI' }));

    expect(await screen.findByText(/Add at least one active product to your catalogue/)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/orders/draft-from-request'))).toBe(false);
  });

  it('shows a verified payment record only for a paid order with a captured PayPal ID', () => {
    const order = {
      id: 'o-paid', reference: 'TD-PAID-001', customerName: 'A customer', customerRequest: 'Ke kopa one chicken meal',
      currency: 'USD', subtotalMinor: 1250, totalMinor: 1250, status: 'PAID', aiGenerated: true,
      createdAt: '2026-11-12T06:00:00.000Z', items: [],
      payments: [{ id: 'attempt-1', status: 'CAPTURED', amountMinor: 1250, currency: 'USD', captureId: 'CAPTURE-123', createdAt: '2026-11-12T06:00:00.000Z', updatedAt: '2026-11-12T06:01:00.000Z' }]
    };
    const { rerender } = render(<VerifiedPaymentRecord order={order}/>);
    expect(screen.getByText('PayPal payment verified')).toBeTruthy();
    expect(screen.getByText('CAPTURE-123')).toBeTruthy();
    expect(screen.getByText('Ke kopa one chicken meal')).toBeTruthy();

    rerender(<VerifiedPaymentRecord order={{ ...order, status: 'AWAITING_PAYMENT' }}/>);
    expect(screen.queryByText('PayPal payment verified')).toBeNull();
  });
});
