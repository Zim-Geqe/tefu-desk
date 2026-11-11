import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import Home from '../app/page';

const user = { id: 'u1', email: 'owner@example.test', name: 'Tefo Owner', memberships: [{ role: 'OWNER', workspace: { id: 'w1', name: 'Corner Kitchen' } }] };
const product = { id: 'p1', name: 'Chicken meal', description: null, sku: null, priceMinor: 8900, currency: 'ZAR', active: true };
const dashboard = { ordersByStatus: {}, capturedPayments: { totalMinor: 0, count: 0 }, completedRefunds: { totalMinor: 0, count: 0 }, netPaidMinor: 0, paymentAttemptsByStatus: {}, awaitingPayments: { count: 0, totalMinor: 0 }, awaitingPaymentOrders: 0, recentActivity: [] };
function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }); }

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
});

