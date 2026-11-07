import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('Fastify application', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://tefo:local@localhost:5432/tefo', NODE_ENV: 'test', LOG_LEVEL: 'silent' });
    app = await buildApp(config);
    await app.ready();
  });
  afterAll(async () => { if (app) await app.close(); });

  it('starts with valid schemas and exposes health and OpenAPI', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });
    expect(health.headers['x-request-id']).toBeTruthy();
    const docs = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(docs.statusCode).toBe(200);
    expect(docs.json().info.title).toBe('Tefo Desk API');
    expect(docs.json().paths['/workspaces/{workspaceId}/orders']).toBeTruthy();
    expect(docs.json().paths['/workspaces/{workspaceId}/orders'].get.security).toEqual([{ cookieAuth: [] }]);
    expect(docs.json().paths['/paypal/webhook/{workspaceId}'].post.security).toEqual([]);
  });
});
