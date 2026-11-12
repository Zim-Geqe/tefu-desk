import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { calculate } from '../src/money.js';
import { HttpAiProvider, validateProposal } from '../src/ai.js';
import { paypalAmount, paypalMinor } from '../src/paypal.js';
import { authorizedWorkspaceId } from '../src/auth.js';

const env = { DATABASE_URL: 'postgresql://tefo:secret@localhost:5432/tefo', NODE_ENV: 'test' };

describe('configuration', () => {
  it('fails fast when database configuration is missing', () => expect(() => loadConfig({})).toThrow(/DATABASE_URL/));
  it('requires provider secrets when AI is enabled', () => expect(() => loadConfig({ ...env, AI_PROVIDER: 'openai' })).toThrow(/AI_API_KEY/));
  it('defaults PayPal to sandbox', () => expect(loadConfig(env).PAYPAL_ENV).toBe('sandbox'));
  it('requires HTTPS and secure cookies in production', () => {
    expect(() => loadConfig({ ...env, NODE_ENV: 'production' })).toThrow(/Production requires/);
    expect(loadConfig({ ...env, NODE_ENV: 'production', COOKIE_SECURE: 'true', APP_ORIGIN: 'https://desk.example.test' }).COOKIE_SECURE).toBe(true);
  });
});

describe('tenant authorization', () => {
  it('allows only the workspace present in the authenticated membership', () => {
    expect(authorizedWorkspaceId({ workspaceId: 'workspace-a' }, 'workspace-a')).toBe('workspace-a');
    expect(authorizedWorkspaceId({ workspaceId: 'workspace-a' }, 'workspace-b')).toBeNull();
    expect(authorizedWorkspaceId(null, 'workspace-a')).toBeNull();
  });
});

describe('money', () => {
  it('calculates integer minor units safely', () => expect(calculate([{ quantity: 3, unitPriceMinor: 1999 }])).toBe(5997));
  it('rejects invalid quantities and overflow', () => {
    expect(() => calculate([{ quantity: 0, unitPriceMinor: 20 }])).toThrow(/quantity/);
    expect(() => calculate([{ quantity: 2, unitPriceMinor: Number.MAX_SAFE_INTEGER }])).toThrow(/range/);
  });
  it('refuses unsupported PayPal currencies', () => expect(() => paypalAmount(1000, 'ZAR')).toThrow(/does not support ZAR/));
  it('formats PayPal amounts using currency precision', () => {
    expect(paypalAmount(1234, 'USD')).toBe('12.34');
    expect(paypalAmount(1200, 'JPY')).toBe('1200');
    expect(paypalMinor('12.34', 'USD')).toBe(1234);
    expect(paypalMinor('1200', 'JPY')).toBe(1200);
    expect(() => paypalMinor('12.345', 'USD')).toThrow(/invalid refund amount/);
  });
});

describe('AI proposal validation', () => {
  const catalog = [{ id: 'p1', name: 'Tea', description: null, sku: null, priceMinor: 450, currency: 'ZAR' }];
  it('accepts only in-catalog product IDs and valid quantities', () => {
    expect(validateProposal({ items: [{ productId: 'p1', quantity: 2, matchNote: 'The request asks for tea.' }], questions: [], explanation: 'Matched tea.' }, catalog, 'ZAR').items[0]).toEqual({ productId: 'p1', quantity: 2, matchNote: 'The request asks for tea.' });
    expect(() => validateProposal({ items: [{ productId: 'other', quantity: 2, matchNote: 'Unknown product.' }], questions: [], explanation: '' }, catalog, 'ZAR')).toThrow(/outside/);
    expect(() => validateProposal({ items: [{ productId: 'p1', quantity: 0, matchNote: 'Tea.' }], questions: [], explanation: '' }, catalog, 'ZAR')).toThrow(/quantity/);
    expect(() => validateProposal({ items: [{ productId: 'p1', quantity: 1, matchNote: '' }], questions: [], explanation: '' }, catalog, 'ZAR')).toThrow(/match note/);
    expect(() => validateProposal({ items: [], questions: Array(11).fill('Question?'), explanation: '' }, catalog, 'ZAR')).toThrow(/oversized/);
  });

  it('calls Gemini over HTTP with the key in a header and validates the returned JSON', async () => {
    let call: { url: string; init?: RequestInit } | undefined;
    const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
      call = { url: String(input), init };
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ items: [{ productId: 'p1', quantity: 1, matchNote: 'The request mentions tea.' }], questions: [], explanation: 'Matched.' }) }] } }] }), { status: 200 });
    }) as typeof fetch;
    const config = loadConfig({ ...env, AI_PROVIDER: 'gemini', AI_MODEL: 'gemini-test', AI_API_KEY: 'secret-test-key' });
    const result = await new HttpAiProvider(config, fetcher).interpret('Ke kopa one tea', catalog, 'ZAR');
    expect(result.items).toEqual([{ productId: 'p1', quantity: 1, matchNote: 'The request mentions tea.' }]);
    expect(call?.url).not.toContain('secret-test-key');
    expect(call?.init?.headers).toMatchObject({ 'x-goog-api-key': 'secret-test-key' });
    const requestBody = JSON.parse(String(call?.init?.body));
    const prompt = requestBody.contents[0].parts[0].text as string;
    expect(prompt).toContain('Sesotho, English, or a mix of both');
    expect(prompt).toContain('Ke kopa one tea');
    expect(prompt).toContain('"id":"p1"');
    expect(prompt).not.toContain('priceMinor');
    expect(prompt).not.toContain('450');
  });

  it('reads OpenAI-compatible responses and rejects malformed provider payloads', async () => {
    const fetcher = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ items: [], questions: ['Which item?'], explanation: 'Need clarification.' }) } }],
    }), { status: 200 })) as typeof fetch;
    const config = loadConfig({ ...env, AI_PROVIDER: 'openai', AI_MODEL: 'test-model', AI_API_KEY: 'test-key' });
    const result = await new HttpAiProvider(config, fetcher).interpret('something', catalog, 'ZAR');
    expect(result.items).toEqual([]);
    expect(result.questions).toEqual(['Which item?']);

    const malformedFetcher = (async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })) as typeof fetch;
    await expect(new HttpAiProvider(config, malformedFetcher).interpret('something', catalog, 'ZAR')).rejects.toThrow(/no structured response/);
  });
});
