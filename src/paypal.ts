import type { Config } from './config.js';

export class PayPalClient {
  readonly base: string;
  constructor(private readonly config: Config, private readonly fetcher: typeof fetch = fetch) { this.base = config.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'; }
  get configured() { return !!this.config.PAYPAL_CLIENT_ID && !!this.config.PAYPAL_CLIENT_SECRET; }
  private async accessToken() {
    if (!this.configured) throw new Error('PayPal is not configured');
    const auth = Buffer.from(`${this.config.PAYPAL_CLIENT_ID}:${this.config.PAYPAL_CLIENT_SECRET}`).toString('base64');
    const response = await this.fetcher(`${this.base}/v1/oauth2/token`, { method: 'POST', headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('PayPal authentication failed');
    const data = await response.json() as { access_token?: string };
    if (!data.access_token) throw new Error('PayPal authentication failed');
    return data.access_token;
  }
  async request(path: string, method: string, payload?: unknown, requestId?: string) {
    const token = await this.accessToken();
    const response = await this.fetcher(`${this.base}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(requestId ? { 'paypal-request-id': requestId } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(20000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error('PayPal request failed'); (error as any).status = response.status; throw error; }
    return data as any;
  }
  async verifyWebhook(headers: Record<string, string | string[] | undefined>, event: unknown) {
    if (!this.config.PAYPAL_WEBHOOK_ID) throw new Error('PayPal webhook verification is not configured');
    const h = (name: string) => { const value = headers[name]; return Array.isArray(value) ? value[0] : value; };
    const result = await this.request('/v1/notifications/verify-webhook-signature', 'POST', {
      auth_algo: h('paypal-auth-algo'), cert_url: h('paypal-cert-url'), transmission_id: h('paypal-transmission-id'),
      transmission_sig: h('paypal-transmission-sig'), transmission_time: h('paypal-transmission-time'), webhook_id: this.config.PAYPAL_WEBHOOK_ID, webhook_event: event
    });
    return result.verification_status === 'SUCCESS';
  }
}

export function paypalApprovalUrl(links: Array<{ rel?: string; href?: string }> | undefined) {
  return links?.find(link => (link.rel === 'approve' || link.rel === 'payer-action') && typeof link.href === 'string' && link.href.length > 0)?.href;
}

export const PAYPAL_CURRENCIES = ['AUD','BRL','CAD','CNY','CZK','DKK','EUR','HKD','HUF','INR','ILS','JPY','MYR','MXN','TWD','NZD','NOK','PHP','PLN','GBP','RUB','SGD','SEK','CHF','THB','USD'] as const;
export function paypalCurrencySupported(currency: string) { return PAYPAL_CURRENCIES.includes(currency as typeof PAYPAL_CURRENCIES[number]); }
export function paypalAmount(minor: number, currency: string) {
  if (!paypalCurrencySupported(currency)) throw new Error(`PayPal does not support ${currency} for this integration`);
  const zeroDecimal = ['JPY','HUF','TWD'].includes(currency);
  const exponent = zeroDecimal ? 0 : 2;
  return exponent === 0 ? String(minor) : `${Math.floor(minor / (10 ** exponent))}.${String(minor % (10 ** exponent)).padStart(exponent, '0')}`;
}

export function paypalMinor(value: string, currency: string): number {
  if (!paypalCurrencySupported(currency)) throw new Error(`PayPal does not support ${currency} for this integration`);
  const exponent = ['JPY','HUF','TWD'].includes(currency) ? 0 : 2;
  const pattern = exponent === 0 ? /^(0|[1-9]\d*)$/ : /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;
  const match = value.match(pattern);
  if (!match) throw new Error('PayPal returned an invalid refund amount');
  const major = Number(match[1]);
  const fractional = exponent === 0 ? 0 : Number((match[2] ?? '').padEnd(exponent, '0'));
  const minor = major * (10 ** exponent) + fractional;
  if (!Number.isSafeInteger(minor)) throw new Error('PayPal refund amount exceeds supported range');
  return minor;
}
