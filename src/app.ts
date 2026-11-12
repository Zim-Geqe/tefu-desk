import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { z } from 'zod';
import { Prisma, PrismaClient } from '@prisma/client';
import type { Config } from './config.js';
import { prisma as defaultDb } from './db.js';
import { authenticate, requireWorkspace as requireWorkspaceCore } from './auth.js';
import { hashToken, newToken } from './security.js';
import { calculate, assertCurrency, formatMinor } from './money.js';
import { HttpAiProvider, aiHealth } from './ai.js';
import { PAYPAL_CURRENCIES, PayPalClient, paypalAmount, paypalApprovalUrl, paypalMinor } from './paypal.js';

const emailSchema = z.string().email().max(320).transform(s => s.toLowerCase());
const passwordSchema = z.string().min(12).max(128).regex(/[A-Z]/, 'Must include an uppercase letter').regex(/[a-z]/, 'Must include a lowercase letter').regex(/[0-9]/, 'Must include a number');
const registerSchema = z.object({ email: emailSchema, password: passwordSchema, name: z.string().trim().min(1).max(120), workspaceName: z.string().trim().min(1).max(160) }).strict();
const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict();
const idSchema = z.string().min(1).max(64);
const productSchema = z.object({ name: z.string().trim().min(1).max(160), description: z.string().max(2000).optional().nullable(), sku: z.string().trim().max(80).optional().nullable(), priceMinor: z.number().int().min(0).max(1000000000), currency: z.string().length(3).transform(s => s.toUpperCase()), active: z.boolean().optional() }).strict();
const customerSchema = z.object({ name: z.string().trim().min(1).max(160), email: emailSchema.optional(), phone: z.string().trim().max(40).optional(), request: z.string().max(3000).optional() });
const orderSchema = z.object({ customer: customerSchema, items: z.array(z.object({ productId: idSchema, quantity: z.number().int().min(1).max(10000) }).strict()).min(1).max(100) }).strict();
const aiDraftSchema = z.object({ customer: customerSchema, request: z.string().trim().min(1).max(3000) }).strict();

type Dependencies = { db?: PrismaClient; passwordHash?: (password: string) => Promise<string>; passwordVerify?: (hash: string, password: string) => Promise<boolean>; ai?: HttpAiProvider; paypal?: PayPalClient };

export async function buildApp(config: Config, dependencies: Dependencies = {}): Promise<FastifyInstance> {
  const db = dependencies.db ?? defaultDb;
  const app = Fastify({ logger: { level: config.LOG_LEVEL, redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'body.password', 'body.apiKey', 'body.clientSecret'], censor: '[REDACTED]' } }, requestIdHeader: 'x-request-id', genReqId: () => newToken().slice(0, 22), bodyLimit: 1024 * 1024 });
  const requireWorkspace = (_app: FastifyInstance, request: any, workspaceId: string) => requireWorkspaceCore(app, request, workspaceId, db);
  (app as any).httpErrors = {
    unauthorized: () => Object.assign(new Error('Authentication required'), { statusCode: 401 }),
    forbidden: () => Object.assign(new Error('Forbidden'), { statusCode: 403 }),
    notFound: (message = 'Not found') => Object.assign(new Error(message), { statusCode: 404 }),
    badRequest: (message = 'Invalid request') => Object.assign(new Error(message), { statusCode: 400 })
  };
  const ai = dependencies.ai ?? new HttpAiProvider(config);
  const paypal = dependencies.paypal ?? new PayPalClient(config);
  const paypalOrderPayload = (order: { id: string; reference: string; currency: string; totalMinor: number; items: Array<{ descriptionSnapshot: string; quantity: number; unitPriceMinor: number; currency: string }> }) => ({
    intent: 'CAPTURE',
    purchase_units: [{ reference_id: order.reference, custom_id: order.id, amount: { currency_code: order.currency, value: paypalAmount(order.totalMinor, order.currency), breakdown: { item_total: { currency_code: order.currency, value: paypalAmount(order.items.reduce((sum, item) => sum + item.quantity * item.unitPriceMinor, 0), order.currency) } } }, items: order.items.map(item => ({ name: item.descriptionSnapshot.slice(0, 127), quantity: String(item.quantity), unit_amount: { currency_code: item.currency, value: paypalAmount(item.unitPriceMinor, item.currency) } })) }],
    application_context: { return_url: `${config.APP_ORIGIN}/payments/paypal/return`, cancel_url: `${config.APP_ORIGIN}/payments/paypal/cancel`, user_action: 'PAY_NOW' }
  });
  await app.register(cookie);
  await app.register(cors, { origin: config.APP_ORIGIN, credentials: true, methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'], exposedHeaders: ['x-request-id'] });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  await app.register(swagger, { openapi: { info: { title: 'Tefo Desk API', version: '1.0.0' }, servers: [{ url: '/api/v1' }], components: { securitySchemes: { cookieAuth: { type: 'apiKey', in: 'cookie', name: 'tefo_session' } } } } });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  app.addHook('onRoute', route => {
    if (route.url.startsWith('/api/v1/')) {
      const publicEndpoint = /^\/api\/v1\/auth\/(register|login|logout)$/.test(route.url) || route.url.startsWith('/api/v1/paypal/webhook/');
      route.schema = {
        ...route.schema,
        tags: route.schema?.tags ?? ['Tefo Desk API'],
        security: publicEndpoint ? [] : [{ cookieAuth: [] }]
      };
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const prismaCode = (error as any).code;
    const status = (error as any).statusCode ?? (prismaCode === 'P2002' ? 409 : prismaCode === 'P2025' ? 404 : 500);
    const safeMessage = prismaCode === 'P2002' ? 'A record with these details already exists' : prismaCode === 'P2025' ? 'Resource not found' : (error as Error).message;
    if (status >= 500) request.log.error({ errorName: (error as Error).name, errorCode: (error as any).code }, 'request failed');
    else request.log.info({ status, reqId: request.id }, 'request rejected');
    reply.code(status).send({ error: status >= 500 ? 'Internal server error' : safeMessage, requestId: request.id });
  });
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    return payload;
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_req, reply) => {
    try { await db.$queryRaw`SELECT 1`; return { status: 'ready', database: 'connected' }; }
    catch { return reply.code(503).send({ status: 'not_ready', database: 'unavailable' }); }
  });
  const api = app.withTypeProvider<any>();
  api.post('/api/v1/auth/register', { schema: { body: { type: 'object', additionalProperties: false, required: ['email','password','name','workspaceName'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', minLength: 12 }, name: { type: 'string', minLength: 1, maxLength: 120 }, workspaceName: { type: 'string', minLength: 1, maxLength: 160 } } } }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request: any, reply: any) => {
    const { email, password, name, workspaceName } = registerSchema.parse(request.body);
    const argon2 = await import('argon2');
    const hash = dependencies.passwordHash
      ? await dependencies.passwordHash(password)
      : await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const token = newToken();
    const result = await db.$transaction(async tx => {
      const user = await tx.user.create({ data: { email, passwordHash: hash, name } });
      const workspace = await tx.workspace.create({ data: { name: workspaceName, memberships: { create: { userId: user.id, role: 'OWNER' } }, business: { create: { name: workspaceName, currency: 'ZAR' } }, aiSettings: { create: {} } } });
      const session = await tx.session.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + config.SESSION_TTL_DAYS * 86400000) } });
      await tx.auditEvent.create({ data: { userId: user.id, workspaceId: workspace.id, action: 'auth.register' } });
      return { user: { id: user.id, email: user.email, name: user.name }, workspace: { id: workspace.id, name: workspace.name }, expiresAt: session.expiresAt };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    reply.setCookie('tefo_session', token, { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'strict', path: '/', maxAge: config.SESSION_TTL_DAYS * 86400 });
    return reply.code(201).send(result);
  });
  api.post('/api/v1/auth/login', { schema: { body: { type: 'object', additionalProperties: false, required: ['email','password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string' } } } }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request: any, reply: any) => {
    const { email, password } = loginSchema.parse(request.body);
    const user = await db.user.findUnique({ where: { email } });
    const verify = dependencies.passwordVerify ?? (await import('argon2')).verify;
    if (!user || !await verify(user.passwordHash, password)) {
      await db.auditEvent.create({ data: { userId: user?.id, action: 'auth.login_failed' } });
      throw (app as any).httpErrors.unauthorized();
    }
    const token = newToken();
    const session = await db.session.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + config.SESSION_TTL_DAYS * 86400000) } });
    await db.auditEvent.create({ data: { userId: user.id, action: 'auth.login' } });
    reply.setCookie('tefo_session', token, { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'strict', path: '/', maxAge: config.SESSION_TTL_DAYS * 86400 });
    return { user: { id: user.id, email: user.email, name: user.name }, expiresAt: session.expiresAt };
  });
  api.post('/api/v1/auth/logout', async (request: any, reply: any) => {
    const token = request.cookies.tefo_session;
    if (token) {
      const session = await db.session.findUnique({ where: { tokenHash: hashToken(token) }, select: { userId: true } });
      await db.session.deleteMany({ where: { tokenHash: hashToken(token) } });
      if (session) await db.auditEvent.create({ data: { userId: session.userId, action: 'auth.logout' } });
    }
    reply.clearCookie('tefo_session', { path: '/' }); return { success: true };
  });
  api.get('/api/v1/auth/me', async (request: any) => {
    const userId = await authenticate(app, request, db);
    return db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true, memberships: { select: { role: true, workspace: { select: { id: true, name: true } } } } } });
  });
  api.post('/api/v1/workspaces', async (request: any, reply: any) => {
    const userId = await authenticate(app, request, db);
    const input = z.object({ name: z.string().trim().min(1).max(160), currency: z.string().length(3).transform(value => value.toUpperCase()).default('ZAR') }).strict().parse(request.body);
    assertCurrency(input.currency);
    const workspace = await db.$transaction(async tx => {
      const created = await tx.workspace.create({ data: { name: input.name, memberships: { create: { userId, role: 'OWNER' } }, business: { create: { name: input.name, currency: input.currency } }, aiSettings: { create: {} } } });
      await tx.auditEvent.create({ data: { workspaceId: created.id, userId, action: 'workspace.created' } });
      return created;
    });
    return reply.code(201).send({ id: workspace.id, name: workspace.name });
  });

  api.get('/api/v1/workspaces/:workspaceId/members', async (request: any) => {
    const { membership } = await requireWorkspace(app, request, request.params.workspaceId);
    if (!['OWNER','ADMIN'].includes(membership.role)) throw (app as any).httpErrors.forbidden();
    return db.membership.findMany({ where: { workspaceId: membership.workspaceId }, orderBy: { createdAt: 'asc' }, select: { role: true, createdAt: true, user: { select: { id: true, email: true, name: true } } } });
  });
  api.post('/api/v1/workspaces/:workspaceId/members', async (request: any, reply: any) => {
    const { userId, membership } = await requireWorkspace(app, request, request.params.workspaceId);
    if (!['OWNER','ADMIN'].includes(membership.role)) throw (app as any).httpErrors.forbidden();
    const input = z.object({ email: emailSchema, role: z.enum(['ADMIN','MEMBER']).default('MEMBER') }).strict().parse(request.body);
    if (membership.role === 'ADMIN' && input.role !== 'MEMBER') throw (app as any).httpErrors.forbidden();
    const user = await db.user.findUnique({ where: { email: input.email }, select: { id: true, email: true, name: true } });
    if (!user) throw (app as any).httpErrors.notFound('Registered user not found');
    if (await db.membership.findUnique({ where: { userId_workspaceId: { userId: user.id, workspaceId: membership.workspaceId } } })) throw (app as any).httpErrors.badRequest('User is already a workspace member');
    const created = await db.membership.create({ data: { userId: user.id, workspaceId: membership.workspaceId, role: input.role }, select: { role: true, createdAt: true, user: { select: { id: true, email: true, name: true } } } });
    await db.auditEvent.create({ data: { workspaceId: membership.workspaceId, userId, action: 'workspace.member_added', entityType: 'membership', entityId: user.id, metadata: { role: input.role } } });
    return reply.code(201).send(created);
  });
  api.patch('/api/v1/workspaces/:workspaceId/members/:memberUserId', async (request: any) => {
    const { userId, membership } = await requireWorkspace(app, request, request.params.workspaceId);
    if (!['OWNER','ADMIN'].includes(membership.role)) throw (app as any).httpErrors.forbidden();
    const input = z.object({ role: z.enum(['ADMIN','MEMBER']) }).strict().parse(request.body);
    if (membership.role === 'ADMIN' && input.role !== 'MEMBER') throw (app as any).httpErrors.forbidden();
    const target = await db.membership.findUnique({ where: { userId_workspaceId: { userId: request.params.memberUserId, workspaceId: membership.workspaceId } } });
    if (!target) throw (app as any).httpErrors.notFound('Workspace member not found');
    if (target.role === 'OWNER') throw (app as any).httpErrors.badRequest('Workspace owner role cannot be changed here');
    const updated = await db.membership.update({ where: { id: target.id }, data: { role: input.role }, select: { userId: true, role: true, createdAt: true } });
    await db.auditEvent.create({ data: { workspaceId: membership.workspaceId, userId, action: 'workspace.member_role_changed', entityType: 'membership', entityId: target.userId, metadata: { role: input.role } } });
    return updated;
  });
  api.delete('/api/v1/workspaces/:workspaceId/members/:memberUserId', async (request: any) => {
    const { userId, membership } = await requireWorkspace(app, request, request.params.workspaceId);
    if (!['OWNER','ADMIN'].includes(membership.role)) throw (app as any).httpErrors.forbidden();
    const target = await db.membership.findUnique({ where: { userId_workspaceId: { userId: request.params.memberUserId, workspaceId: membership.workspaceId } } });
    if (!target) throw (app as any).httpErrors.notFound('Workspace member not found');
    if (target.role === 'OWNER') throw (app as any).httpErrors.badRequest('Workspace owner cannot be removed');
    if (membership.role === 'ADMIN' && target.role !== 'MEMBER') throw (app as any).httpErrors.forbidden();
    await db.membership.delete({ where: { id: target.id } });
    await db.auditEvent.create({ data: { workspaceId: membership.workspaceId, userId, action: 'workspace.member_removed', entityType: 'membership', entityId: target.userId } });
    return { removed: true };
  });

  api.get('/api/v1/workspaces/:workspaceId/business', async (request: any) => {
    const { membership } = await requireWorkspace(app, request, request.params.workspaceId);
    return db.business.findUnique({ where: { workspaceId: membership.workspaceId } });
  });
  api.patch('/api/v1/workspaces/:workspaceId/business', async (request: any) => {
    const { userId, membership } = await requireWorkspace(app, request, request.params.workspaceId);
    if (!['OWNER', 'ADMIN'].includes(membership.role)) throw (app as any).httpErrors.forbidden();
    const schema = z.object({ name: z.string().trim().min(1).max(160).optional(), currency: z.string().length(3).transform(v => v.toUpperCase()).optional(), email: emailSchema.optional().nullable(), phone: z.string().max(40).optional().nullable(), address: z.string().max(500).optional().nullable() }).strict();
    const data = schema.parse(request.body);
    if (data.currency) assertCurrency(data.currency);
    if (data.currency && data.currency !== (await db.business.findUniqueOrThrow({ where: { workspaceId: membership.workspaceId }, select: { currency: true } })).currency) {
      const [products, orders] = await Promise.all([
        db.product.count({ where: { workspaceId: membership.workspaceId } }),
        db.order.count({ where: { workspaceId: membership.workspaceId } })
      ]);
      if (products || orders) throw (app as any).httpErrors.badRequest('Currency cannot change after catalog or order data exists');
    }
    const result = await db.business.update({ where: { workspaceId: membership.workspaceId }, data });
    await db.auditEvent.create({ data: { workspaceId: membership.workspaceId, userId, action: 'business.updated' } });
    return result;
  });

  api.get('/api/v1/workspaces/:workspaceId/products', async (request: any) => {
    const { membership } = await requireWorkspace(app, request, request.params.workspaceId);
    return db.product.findMany({ where: { workspaceId: membership.workspaceId }, orderBy: { createdAt: 'desc' } });
  });
  api.post('/api/v1/workspaces/:workspaceId/products', { schema: { body: { type: 'object', additionalProperties: false, required: ['name','priceMinor','currency'], properties: { name: { type: 'string', minLength: 1, maxLength: 160 }, description: { type: ['string','null'] }, sku: { type: ['string','null'] }, priceMinor: { type: 'integer', minimum: 0 }, currency: { type: 'string', pattern: '^[A-Za-z]{3}$' }, active: { type: 'boolean' } } } } }, async (request: any, reply: any) => {
    const { userId, membership } = await requireWorkspace(app, request, request.params.workspaceId);
    const input = productSchema.parse(request.body); assertCurrency(input.currency);
    const business = await db.business.findUniqueOrThrow({ where: { workspaceId: membership.workspaceId } });
    if (input.currency !== business.currency) throw (app as any).httpErrors.badRequest('Product currency must match business currency');
    const product = await db.product.create({ data: { ...input, workspaceId: membership.workspaceId } });
    await db.auditEvent.create({ data: { workspaceId: membership.workspaceId, userId, action: 'product.created', entityType: 'product', entityId: product.id } });
    return reply.code(201).send(product);
  });
  api.patch('/api/v1/workspaces/:workspaceId/products/:productId', async (request: any) => {
    const { userId, membership } = await requireWorkspace(app, request, request.params.workspaceId);
    const input = productSchema.partial().strict().parse(request.body);
    if (input.currency) assertCurrency(input.currency);
    const found = await db.product.findFirst({ where: { id: request.params.productId, workspaceId: membership.workspaceId } });
    if (!found) throw (app as any).httpErrors.notFound('Product not found');
    if (input.currency && input.currency !== found.currency) throw (app as any).httpErrors.badRequest('Product currency cannot change after creation');
    const product = await db.product.update({ where: { id: found.id }, data: input });
    await db.auditEvent.create({ data: { workspaceId: membership.workspaceId, userId, action: 'product.updated', entityType: 'product', entityId: product.id } });
    return product;
  });
  api.delete('/api/v1/workspaces/:workspaceId/products/:productId', async (request: any) => {
    const { userId, membership } = await requireWorkspace(app, request, request.params.workspaceId);
    const found = await db.product.findFirst({ where: { id: request.params.productId, workspaceId: membership.workspaceId } });
    if (!found) throw (app as any).httpErrors.notFound('Product not found');
    const product = await db.product.update({ where: { id: found.id }, data: { active: false } });
    await db.auditEvent.create({ data: { workspaceId: membership.workspaceId, userId, action: 'product.deactivated', entityType: 'product', entityId: product.id } });
    return product;
  });

  async function createOrder(workspaceId: string, customer: z.infer<typeof customerSchema>, lines: Array<{ productId: string; quantity: number }>, aiGenerated: boolean, requestText?: string) {
    return db.$transaction(async tx => {
      const products = await tx.product.findMany({ where: { workspaceId, active: true, id: { in: lines.map(l => l.productId) } } });
      if (products.length !== new Set(lines.map(l => l.productId)).size) throw Object.assign(new Error('One or more products are unavailable'), { statusCode: 400 });
      const business = await tx.business.findUniqueOrThrow({ where: { workspaceId } });
      const mapped = lines.map(line => { const p = products.find(product => product.id === line.productId)!; if (p.currency !== business.currency) throw Object.assign(new Error('Product currency mismatch'), { statusCode: 400 }); return { product: p, quantity: line.quantity, unitPriceMinor: p.priceMinor }; });
      const total = calculate(mapped);
      const reference = `TD-${newToken().slice(0, 12).toUpperCase()}`;
      const order = await tx.order.create({ data: { workspaceId, reference, customerName: customer.name, customerEmail: customer.email, customerPhone: customer.phone, customerRequest: requestText ?? customer.request, currency: business.currency, subtotalMinor: total, totalMinor: total, aiGenerated, status: 'DRAFT', items: { create: mapped.map(m => ({ productId: m.product.id, descriptionSnapshot: m.product.name + (m.product.description ? ` — ${m.product.description}` : ''), skuSnapshot: m.product.sku, quantity: m.quantity, unitPriceMinor: m.unitPriceMinor, lineTotalMinor: m.quantity * m.unitPriceMinor, currency: business.currency })) } } });
      return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
    });
  }
  api.post('/api/v1/workspaces/:workspaceId/orders', { schema: { body: { type: 'object', additionalProperties: false, required: ['customer','items'], properties: { customer: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, email: { type: 'string', format: 'email' }, phone: { type: 'string' }, request: { type: 'string' } } }, items: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['productId','quantity'], properties: { productId: { type: 'string' }, quantity: { type: 'integer', minimum: 1 } } } } } } } }, async (request: any, reply: any) => {
    const { userId, membership } = await requireWorkspace(app, request, request.params.workspaceId);
    const input = orderSchema.parse(request.body);
    const order = await createOrder(membership.workspaceId, input.customer, input.items, false);
    await db.auditEvent.create({ data: { workspaceId: membership.workspaceId, userId, action: 'order.created', entityType: 'order', entityId: order.id } });
    return reply.code(201).send(order);
  });
  api.get('/api/v1/workspaces/:workspaceId/orders', async (request: any) => {
    const { membership } = await requireWorkspace(app, request, request.params.workspaceId);
    const q = z.object({ status: z.enum(['DRAFT','AWAITING_PAYMENT','PAID','CANCELLED','PAYMENT_FAILED','REFUNDED']).optional(), search: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().optional(), sort: z.enum(['asc','desc']).default('desc') }).parse(request.query);
    const where: Prisma.OrderWhereInput = { workspaceId: membership.workspaceId, ...(q.status ? { status: q.status } : {}), ...(q.search ? { OR: [{ reference: { contains: q.search, mode: 'insensitive' } }, { customerName: { contains: q.search, mode: 'insensitive' } }, { customerEmail: { contains: q.search, mode: 'insensitive' } }] } : {}) };
    const rows = await db.order.findMany({ where, take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}), orderBy: [{ createdAt: q.sort }, { id: q.sort }], include: { items: true, payments: { select: { id: true, status: true, amountMinor: true, currency: true, createdAt: true } } } });
    const hasMore = rows.length > q.limit; const data = rows.slice(0, q.limit);
    return { data, nextCursor: hasMore ? data[data.length - 1]?.id : null };
  });
  api.get('/api/v1/workspaces/:workspaceId/orders/:orderId', async (request: any) => {
    const { membership } = await requireWorkspace(app, request, request.params.workspaceId);
    const order = await db.order.findFirst({ where: { id: request.params.orderId, workspaceId: membership.workspaceId }, include: { items: true, payments: true } });
    if (!order) throw (app as any).httpErrors.notFound('Order not found');
    return order;
  });
  api.patch('/api/v1/workspaces/:workspaceId/orders/:orderId', async (request: any) => {
    const { userId, membership } = await requireWorkspace(app, request, request.params.workspaceId);
    const input = z.object({
      customer: z.object({ name: z.string().trim().min(1).max(160).optional(), email: emailSchema.optional().nullable(), phone: z.string().trim().max(40).optional().nullable(), request: z.string().max(3000).optional().nullable() }).strict().optional(),
      items: z.array(z.object({ productId: idSchema, quantity: z.number().int().min(1).max(10000) }).strict()).min(1).max(100).optional()
    }).strict().refine(value => !!value.customer || !!value.items, 'At least one update field is required').parse(request.body);
    const updated = await db.$transaction(async tx => {
      const order = await tx.order.findFirst({ where: { id: request.params.orderId, workspaceId: membership.workspaceId }, include: { items: true } });
      if (!order) throw Object.assign(new Error('Order not found'), { statusCode: 404 });
      if (order.status !== 'DRAFT') throw Object.assign(new Error('Only draft orders can be edited'), { statusCode: 409 });
      const changes: Prisma.OrderUpdateInput = {};
      if (input.customer) {
        if (input.customer.name !== undefined) changes.customerName = input.customer.name;
        if (input.customer.email !== undefined) changes.customerEmail = input.customer.email;
        if (input.customer.phone !== undefined) changes.customerPhone = input.customer.phone;
        if (input.customer.request !== undefined) changes.customerRequest = input.customer.request;
      }
      if (input.items) {
        const products = await tx.product.findMany({ where: { workspaceId: membership.workspaceId, active: true, id: { in: input.items.map(line => line.productId) } } });
        if (products.length !== new Set(input.items.map(line => line.productId)).size) throw Object.assign(new Error('One or more products are unavailable'), { statusCode: 400 });
        const mapped = input.items.map(line => {
          const product = products.find(item => item.id === line.productId)!;
          if (product.currency !== order.currency) throw Object.assign(new Error('Product currency mismatch'), { statusCode: 400 });
          return { product, quantity: line.quantity, unitPriceMinor: product.priceMinor };
        });
        const totalMinor = calculate(mapped);
        await tx.orderItem.deleteMany({ where: { orderId: order.id } });
        changes.subtotalMinor = totalMinor;
        changes.totalMinor = totalMinor;
        changes.items = { create: mapped.map(line => ({ productId: line.product.id, descriptionSnapshot: line.product.name + (line.product.description ? ` — ${line.product.description}` : ''), skuSnapshot: line.product.sku, quantity: line.quantity, unitPriceMinor: line.unitPriceMinor, lineTotalMinor: line.quantity * line.unitPriceMinor, currency: order.currency })) };
      }
      return tx.order.update({ where: { id: order.id }, data: changes, include: { items: true } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    await db.auditEvent.create({ data: { workspaceId: membership.workspaceId, userId, action: 'order.updated', entityType: 'order', entityId: updated.id } });
    return updated;
  });
  api.post('/api/v1/workspaces/:workspaceId/orders/draft-from-request', async (request: any, reply: any) => {
    const { userId, membership } = await requireWorkspace(app, request, request.params.workspaceId);
    const input = aiDraftSchema.parse(request.body);
    const aiSettings = await db.aiSettings.findUnique({ where: { workspaceId: membership.workspaceId } });
    if (!aiSettings || aiSettings.provider === 'NONE') throw Object.assign(new Error('AI is disabled for this workspace'), { statusCode: 503 });
    if (aiSettings.provider !== config.AI_PROVIDER.toUpperCase() || aiSettings.model !== config.AI_MODEL) throw Object.assign(new Error('Workspace AI selection is not available in deployment configuration'), { statusCode: 503 });
    const business = await db.business.findUniqueOrThrow({ where: { workspaceId: membership.workspaceId } });
    const catalog = await db.product.findMany({ where: { workspaceId: membership.workspaceId, active: true }, select: { id: true, name: true, description: true, sku: true, priceMinor: true, currency: true } });
    if (!catalog.length) throw Object.assign(new Error('Add at least one active product to the catalogue before drafting an order'), { statusCode: 409 });
    const proposal = await ai.interpret(input.request, catalog, business.currency);
    const needsClarification = proposal.questions.length > 0 || proposal.items.length === 0;
    if (needsClarification) return { draft: null, items: proposal.items, questions: proposal.questions, explanation: proposal.explanation, requiresConfirmation: true };
    const draft = await createOrder(membership.workspaceId, input.customer, proposal.items, true, input.request);
    await db.auditEvent.create({ data: { workspaceId: membership.workspaceId, userId, action: 'order.ai_draft_created', entityType: 'order', entityId: draft.id } });
    return reply.code(201).send({ draft, questions: proposal.questions, explanation: proposal.explanation, requiresConfirmation: true });
  });
  api.post('/api/v1/workspaces/:workspaceId/orders/:orderId/confirm', async (request: any) => {
    const { userId, membership } = await requireWorkspace(app, request, request.params.workspaceId);
    const order = await db.$transaction(async tx => {
      const found = await tx.order.findFirst({ where: { id: request.params.orderId, workspaceId: membership.workspaceId } });
      if (!found) throw Object.assign(new Error('Order not found'), { statusCode: 404 });
      if (found.status !== 'DRAFT') throw Object.assign(new Error('Only draft orders can be confirmed'), { statusCode: 409 });
      return tx.order.update({ where: { id: found.id }, data: { status: 'AWAITING_PAYMENT', confirmedById: userId, confirmedAt: new Date() }, include: { items: true } });
    });
    await db.auditEvent.create({ data: { workspaceId: membership.workspaceId, userId, action: 'order.confirmed', entityType: 'order', entityId: order.id } });
    return order;
  });
  api.post('/api/v1/workspaces/:workspaceId/orders/:orderId/cancel', async (request: any) => {
    const { userId, membership } = await requireWorkspace(app, request, request.params.workspaceId);
    const order = await db.$transaction(async tx => {
      const found = await tx.order.findFirst({ where: { id: request.params.orderId, workspaceId: membership.workspaceId } });
      if (!found) throw Object.assign(new Error('Order not found'), { statusCode: 404 });
      if (!['DRAFT','AWAITING_PAYMENT','PAYMENT_FAILED'].includes(found.status)) throw Object.assign(new Error('Order cannot be cancelled from its current state'), { statusCode: 409 });
      const pending = await tx.paymentAttempt.count({ where: { orderId: found.id, status: { in: ['CREATED','APPROVED','CAPTURE_PENDING','UNCERTAIN'] } } });
      if (pending) throw Object.assign(new Error('Order has an unresolved payment attempt'), { statusCode: 409 });
      return tx.order.update({ where: { id: found.id }, data: { status: 'CANCELLED' } });
    });
    await db.auditEvent.create({ data: { workspaceId: membership.workspaceId, userId, action: 'order.cancelled', entityType: 'order', entityId: order.id } });
    return order;
  });
  api.post('/api/v1/workspaces/:workspaceId/orders/:orderId/follow-up-draft', async (request: any) => {
    const { membership } = await requireWorkspace(app, request, request.params.workspaceId);
    const order = await db.order.findFirst({ where: { id: request.params.orderId, workspaceId: membership.workspaceId }, include: { payments: true } });
    if (!order) throw (app as any).httpErrors.notFound('Order not found');
    const text = `Hello ${order.customerName}, your order ${order.reference} is ${order.status.toLowerCase().replaceAll('_',' ')}. Total: ${formatMinor(order.totalMinor, order.currency)}. Please contact us if you need assistance.`;
    return { text, delivery: 'not_sent', paymentAttempts: order.payments.map(p => ({ status: p.status, amountMinor: p.amountMinor, currency: p.currency })) };
  });

  api.get('/api/v1/workspaces/:workspaceId/settings/ai', async (request: any) => {
    const { membership } = await requireWorkspace(app, request, request.params.workspaceId);
    const saved = await db.aiSettings.findUnique({ where: { workspaceId: membership.workspaceId } });
    return { ...aiHealth(config), workspaceProvider: saved?.provider ?? 'NONE', workspaceModel: saved?.model ?? null };
  });
  api.patch('/api/v1/workspaces/:workspaceId/settings/ai', async (request: any) => {
    const { userId, membership } = await requireWorkspace(app, request, request.params.workspaceId);
    if (!['OWNER','ADMIN'].includes(membership.role)) throw (app as any).httpErrors.forbidden();
    const input = z.object({ provider: z.enum(['NONE','GEMINI','OPENAI','COMPATIBLE']), model: z.string().trim().min(1).max(160).optional() }).strict().parse(request.body);
    if (input.provider !== 'NONE' && input.provider !== config.AI_PROVIDER.toUpperCase()) throw (app as any).httpErrors.badRequest('Provider secrets are configured by the deployment environment; requested provider is unavailable');
    if (input.provider !== 'NONE' && input.model && input.model !== config.AI_MODEL) throw (app as any).httpErrors.badRequest('Only the deployment-configured model is available');
    const saved = await db.aiSettings.upsert({ where: { workspaceId: membership.workspaceId }, create: { workspaceId: membership.workspaceId, provider: input.provider, model: input.model ?? (input.provider === 'NONE' ? null : config.AI_MODEL) }, update: { provider: input.provider, model: input.model ?? (input.provider === 'NONE' ? null : config.AI_MODEL) } });
    await db.auditEvent.create({ data: { workspaceId: membership.workspaceId, userId, action: 'settings.ai.updated' } });
    return { provider: saved.provider, model: saved.model, secretsConfiguredBy: 'environment' };
  });

  api.get('/api/v1/workspaces/:workspaceId/settings/paypal', async (request: any) => {
    await requireWorkspace(app, request, request.params.workspaceId);
    return { environment: config.PAYPAL_ENV, configured: 'configured' in paypal && paypal.configured, supportedCurrencies: PAYPAL_CURRENCIES };
  });

  api.post('/api/v1/workspaces/:workspaceId/orders/:orderId/paypal-checkout', async (request: any, reply: any) => {
    const { userId, membership } = await requireWorkspace(app, request, request.params.workspaceId);
    const input = z.object({ idempotencyKey: z.string().min(8).max(128) }).strict().parse(request.body);
    if ('configured' in paypal && !paypal.configured) throw Object.assign(new Error('PayPal is not configured for this environment'), { statusCode: 503 });
    const result = await db.$transaction(async tx => {
      const order = await tx.order.findFirst({ where: { id: request.params.orderId, workspaceId: membership.workspaceId }, include: { items: true } });
      if (!order) throw Object.assign(new Error('Order not found'), { statusCode: 404 });
      if (!['AWAITING_PAYMENT','PAYMENT_FAILED'].includes(order.status)) throw Object.assign(new Error('Order must be confirmed before checkout'), { statusCode: 409 });
      if (order.totalMinor <= 0) throw Object.assign(new Error('PayPal checkout requires a positive total'), { statusCode: 400 });
      try { paypalAmount(order.totalMinor, order.currency); }
      catch (error) { throw Object.assign(error as Error, { statusCode: 400 }); }
      const existing = await tx.paymentAttempt.findUnique({ where: { workspaceId_idempotencyKey: { workspaceId: membership.workspaceId, idempotencyKey: input.idempotencyKey } } });
      if (existing) { if (existing.orderId !== order.id) throw Object.assign(new Error('Idempotency key already used'), { statusCode: 409 }); return { order, attempt: existing, existing: true }; }
      const attempts = await tx.paymentAttempt.count({ where: { orderId: order.id, status: { in: ['CREATED','APPROVED','CAPTURE_PENDING','UNCERTAIN'] } } });
      if (attempts) throw Object.assign(new Error('An unresolved payment attempt already exists'), { statusCode: 409 });
      const attempt = await tx.paymentAttempt.create({ data: { workspaceId: membership.workspaceId, orderId: order.id, amountMinor: order.totalMinor, currency: order.currency, idempotencyKey: input.idempotencyKey } });
      if (order.status === 'PAYMENT_FAILED') await tx.order.update({ where: { id: order.id }, data: { status: 'AWAITING_PAYMENT' } });
      return { order, attempt, existing: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (result.attempt.paypalOrderId && result.attempt.approvalUrl) return { paymentAttemptId: result.attempt.id, paypalOrderId: result.attempt.paypalOrderId, approvalUrl: result.attempt.approvalUrl, reused: true, environment: config.PAYPAL_ENV };
    if (result.existing && result.attempt.status === 'UNCERTAIN') throw (app as any).httpErrors.badRequest('Payment creation outcome is uncertain; reconcile before retrying');
    await db.auditEvent.create({ data: { workspaceId: membership.workspaceId, userId, action: 'payment.initiated', entityType: 'order', entityId: result.order.id } });
    try {
      const pp = await paypal.request('/v2/checkout/orders', 'POST', paypalOrderPayload(result.order), result.attempt.id);
      const approve = paypalApprovalUrl(pp.links);
      if (!pp.id || !approve) throw new Error('PayPal returned an invalid checkout order');
      const saved = await db.paymentAttempt.update({ where: { id: result.attempt.id }, data: { paypalOrderId: pp.id, approvalUrl: approve, status: 'CREATED' } });
      return { paymentAttemptId: saved.id, paypalOrderId: pp.id, approvalUrl: approve, reused: false, environment: config.PAYPAL_ENV };
    } catch (_error) {
      await db.paymentAttempt.update({ where: { id: result.attempt.id }, data: { status: 'UNCERTAIN', lastErrorCode: 'PAYPAL_CREATE_UNCERTAIN' } });
      request.log.error({ paymentAttemptId: result.attempt.id }, 'PayPal order creation uncertain');
      return reply.code(202).send({ paymentAttemptId: result.attempt.id, status: 'UNCERTAIN', reconciliationRequired: true });
    }
  });
  api.post('/api/v1/workspaces/:workspaceId/payment-attempts/:attemptId/capture', async (request: any) => {
    const { userId, membership } = await requireWorkspace(app, request, request.params.workspaceId);
    const outcome = await db.$transaction(async tx => {
      const attempt = await tx.paymentAttempt.findFirst({ where: { id: request.params.attemptId, workspaceId: membership.workspaceId }, include: { order: { include: { items: true } } } });
      if (!attempt) throw Object.assign(new Error('Payment attempt not found'), { statusCode: 404 });
      if (attempt.status === 'CAPTURED') return { done: true, attempt };
      if (['CAPTURE_PENDING','UNCERTAIN'].includes(attempt.status)) throw Object.assign(new Error('Capture is unresolved; reconcile before retrying'), { statusCode: 409 });
      if (!['CREATED','APPROVED'].includes(attempt.status) || !attempt.paypalOrderId) throw Object.assign(new Error('Payment attempt cannot be captured'), { statusCode: 409 });
      await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: 'CAPTURE_PENDING' } });
      return { done: false, attempt };
    });
    if (outcome.done) return { status: 'CAPTURED', paymentAttemptId: outcome.attempt.id };
    await db.auditEvent.create({ data: { workspaceId: membership.workspaceId, userId, action: 'payment.capture.started', entityType: 'paymentAttempt', entityId: outcome.attempt.id } });
    try {
      const response = await paypal.request(`/v2/checkout/orders/${encodeURIComponent(outcome.attempt.paypalOrderId!)}/capture`, 'POST', {}, `capture-${outcome.attempt.id}`);
      const purchase = response.purchase_units?.find((p: any) => p.reference_id === outcome.attempt.order.reference);
      const capture = purchase?.payments?.captures?.[0];
      const value = capture?.amount?.value; const expected = paypalAmount(outcome.attempt.amountMinor, outcome.attempt.currency);
      if (!purchase || purchase.custom_id !== outcome.attempt.order.id || capture?.amount?.currency_code !== outcome.attempt.currency || value !== expected) throw new Error('PayPal capture did not match persisted order');
      if (capture.status !== 'COMPLETED') {
        const mapped = capture.status === 'DENIED' ? 'DENIED' : 'UNCERTAIN';
        await db.$transaction(async tx => {
          await tx.paymentAttempt.update({ where: { id: outcome.attempt.id }, data: { status: mapped, lastErrorCode: capture.status ?? 'CAPTURE_PENDING' } });
          if (mapped === 'DENIED') await tx.order.updateMany({ where: { id: outcome.attempt.orderId, workspaceId: membership.workspaceId, status: 'AWAITING_PAYMENT' }, data: { status: 'PAYMENT_FAILED' } });
        });
        return { status: mapped, paymentAttemptId: outcome.attempt.id };
      }
      const done = await db.$transaction(async tx => {
        const current = await tx.paymentAttempt.findUniqueOrThrow({ where: { id: outcome.attempt.id } });
        if (current.status === 'CAPTURED') return current;
        if (current.status !== 'CAPTURE_PENDING') throw new Error('Payment attempt state changed during capture');
        const updated = await tx.paymentAttempt.update({ where: { id: current.id }, data: { status: 'CAPTURED', captureId: capture.id } });
        await tx.order.update({ where: { id: current.orderId }, data: { status: 'PAID' } });
        await tx.auditEvent.create({ data: { workspaceId: current.workspaceId, userId, action: 'payment.captured', entityType: 'paymentAttempt', entityId: current.id } });
        return updated;
      });
      return { status: 'CAPTURED', paymentAttemptId: done.id };
    } catch (_error) {
      await db.paymentAttempt.update({ where: { id: outcome.attempt.id }, data: { status: 'UNCERTAIN', lastErrorCode: 'CAPTURE_UNCERTAIN' } });
      request.log.error({ paymentAttemptId: outcome.attempt.id }, 'PayPal capture uncertain');
      throw (app as any).httpErrors.badRequest('Capture outcome is uncertain; reconcile with PayPal before retrying');
    }
  });
  api.post('/api/v1/workspaces/:workspaceId/payment-attempts/:attemptId/reconcile', async (request: any) => {
    const { userId, membership } = await requireWorkspace(app, request, request.params.workspaceId);
    const attempt = await db.paymentAttempt.findFirst({ where: { id: request.params.attemptId, workspaceId: membership.workspaceId }, include: { order: { include: { items: true } } } });
    if (!attempt) throw (app as any).httpErrors.notFound('Payment attempt not found');
    if (attempt.status === 'CAPTURED') return { status: 'CAPTURED', paymentAttemptId: attempt.id };
    if (!attempt.paypalOrderId) {
      if (attempt.status !== 'UNCERTAIN' || attempt.lastErrorCode !== 'PAYPAL_CREATE_UNCERTAIN') throw (app as any).httpErrors.badRequest('No PayPal order ID is available to reconcile');
      try {
        const created = await paypal.request('/v2/checkout/orders', 'POST', paypalOrderPayload(attempt.order), attempt.id);
        const approvalUrl = paypalApprovalUrl(created.links);
        if (!created.id || !approvalUrl) throw new Error('PayPal returned an invalid order during reconciliation');
        const saved = await db.paymentAttempt.update({ where: { id: attempt.id }, data: { paypalOrderId: created.id, approvalUrl, status: 'CREATED', lastErrorCode: null } });
        await db.auditEvent.create({ data: { workspaceId: membership.workspaceId, userId, action: 'payment.creation_reconciled', entityType: 'paymentAttempt', entityId: saved.id } });
        return { status: 'CREATED', paymentAttemptId: saved.id, paypalOrderId: saved.paypalOrderId, approvalUrl: saved.approvalUrl };
      } catch (_error) {
        throw (app as any).httpErrors.badRequest('PayPal order creation remains uncertain; retry reconciliation with the same attempt');
      }
    }
    const providerOrder = await paypal.request(`/v2/checkout/orders/${encodeURIComponent(attempt.paypalOrderId)}`, 'GET');
    const purchase = providerOrder.purchase_units?.find((p: any) => p.reference_id === attempt.order.reference);
    if (!purchase || purchase.custom_id !== attempt.orderId || purchase.amount?.currency_code !== attempt.currency || purchase.amount?.value !== paypalAmount(attempt.amountMinor, attempt.currency)) throw (app as any).httpErrors.badRequest('PayPal order does not match the persisted order');
    const captures = purchase.payments?.captures ?? [];
    const completed = captures.find((capture: any) => capture.status === 'COMPLETED' && capture.amount?.currency_code === attempt.currency && capture.amount?.value === paypalAmount(attempt.amountMinor, attempt.currency));
    if (completed) {
      await db.$transaction(async tx => {
        const current = await tx.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
        if (current.status === 'CAPTURED') return;
        await tx.paymentAttempt.update({ where: { id: current.id }, data: { status: 'CAPTURED', captureId: completed.id, lastErrorCode: null } });
        await tx.order.update({ where: { id: current.orderId }, data: { status: 'PAID' } });
        await tx.auditEvent.create({ data: { workspaceId: membership.workspaceId, userId, action: 'payment.reconciled_captured', entityType: 'paymentAttempt', entityId: current.id } });
      });
      return { status: 'CAPTURED', paymentAttemptId: attempt.id };
    }
    const awaitingPayer = ['CREATED', 'PAYER_ACTION_REQUIRED', 'SAVED'].includes(providerOrder.status);
    const approvalUrl = providerOrder.links?.find((link: any) => link.rel === 'payer-action' || link.rel === 'approve')?.href || attempt.approvalUrl;
    if (awaitingPayer && approvalUrl) {
      await db.paymentAttempt.update({ where: { id: attempt.id }, data: { status: 'CREATED', approvalUrl, lastErrorCode: null } });
      await db.auditEvent.create({ data: { workspaceId: membership.workspaceId, userId, action: 'payment.reconciled', entityType: 'paymentAttempt', entityId: attempt.id } });
      return { status: 'CREATED', paymentAttemptId: attempt.id, paypalOrderId: attempt.paypalOrderId, approvalUrl };
    }
    const denied = captures.find((capture: any) => capture.status === 'DENIED');
    const nextStatus = denied ? 'DENIED' : providerOrder.status === 'APPROVED' ? 'APPROVED' : 'UNCERTAIN';
    await db.$transaction(async tx => {
      await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: nextStatus, lastErrorCode: denied ? 'PAYPAL_CAPTURE_DENIED' : nextStatus === 'APPROVED' ? null : 'PAYPAL_OUTCOME_UNRESOLVED' } });
      if (denied) await tx.order.updateMany({ where: { id: attempt.orderId, workspaceId: membership.workspaceId, status: 'AWAITING_PAYMENT' }, data: { status: 'PAYMENT_FAILED' } });
    });
    await db.auditEvent.create({ data: { workspaceId: membership.workspaceId, userId, action: 'payment.reconciled', entityType: 'paymentAttempt', entityId: attempt.id } });
    return { status: nextStatus, paymentAttemptId: attempt.id, ...(nextStatus === 'APPROVED' && approvalUrl ? { approvalUrl } : {}) };
  });
  api.post('/api/v1/paypal/webhook/:workspaceId', async (request: any, reply: any) => {
    const workspaceId = request.params.workspaceId;
    if (!await db.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })) throw (app as any).httpErrors.notFound('Workspace not found');
    const event = request.body as any;
    if (!event?.id || !event?.event_type) throw (app as any).httpErrors.badRequest('Invalid webhook event');
    let verified = false;
    try { verified = await paypal.verifyWebhook(request.headers, event); } catch { request.log.warn({ eventId: event.id }, 'PayPal webhook verification unavailable'); }
    if (!verified) return reply.code(400).send({ error: 'Webhook signature verification failed' });
    await db.webhookEvent.createMany({ data: [{ workspaceId, eventId: event.id, eventType: event.event_type }], skipDuplicates: true });
    const storedEvent = await db.webhookEvent.findUnique({ where: { workspaceId_eventId: { workspaceId, eventId: event.id } } });
    if (storedEvent?.processedAt) return { received: true, duplicate: true };
    const resource = event.resource;
    if (event.event_type === 'PAYMENT.CAPTURE.REFUNDED') {
      if (typeof resource?.id !== 'string') throw new Error('PayPal refund webhook has no refund ID');
      const providerRefund = await paypal.request(`/v2/payments/refunds/${encodeURIComponent(resource.id)}`, 'GET');
      if (providerRefund.id !== resource.id || !providerRefund.amount?.currency_code || typeof providerRefund.amount?.value !== 'string') throw new Error('PayPal refund response is invalid');
      const captureId = resource.supplementary_data?.related_ids?.capture_id ?? providerRefund.supplementary_data?.related_ids?.capture_id;
      if (typeof captureId !== 'string') throw new Error('PayPal refund has no correlated capture ID');
      const attempt = await db.paymentAttempt.findUnique({ where: { captureId } });
      if (!attempt || attempt.workspaceId !== workspaceId || !['CAPTURED','REFUNDED'].includes(attempt.status)) throw new Error('PayPal refund is not associated with a captured workspace payment');
      const amountMinor = paypalMinor(providerRefund.amount.value, providerRefund.amount.currency_code);
      if (providerRefund.amount.currency_code !== attempt.currency || amountMinor <= 0) throw new Error('PayPal refund does not match the captured payment currency or amount');
      const refundStatus = z.enum(['PENDING','COMPLETED','FAILED','CANCELLED']).parse(providerRefund.status);
      await db.$transaction(async tx => {
        await tx.refund.upsert({
          where: { paypalRefundId: providerRefund.id },
          create: { workspaceId, paymentAttemptId: attempt.id, paypalRefundId: providerRefund.id, amountMinor, currency: attempt.currency, status: refundStatus },
          update: { amountMinor, currency: attempt.currency, status: refundStatus }
        });
        const completedRefunds = await tx.refund.aggregate({ where: { paymentAttemptId: attempt.id, status: 'COMPLETED' }, _sum: { amountMinor: true } });
        const refundedMinor = completedRefunds._sum.amountMinor ?? 0;
        if (refundedMinor > attempt.amountMinor) throw new Error('Verified PayPal refunds exceed the captured payment amount');
        if (refundedMinor === attempt.amountMinor) {
          await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: 'REFUNDED' } });
          await tx.order.update({ where: { id: attempt.orderId }, data: { status: 'REFUNDED' } });
        }
        await tx.auditEvent.create({ data: { workspaceId, action: refundStatus === 'COMPLETED' ? 'payment.refund_recorded' : 'payment.refund_status_updated', entityType: 'refund', entityId: providerRefund.id, metadata: { status: refundStatus, amountMinor } } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    }
    const captureEvent = typeof event.event_type === 'string' && event.event_type.startsWith('PAYMENT.CAPTURE.') && event.event_type !== 'PAYMENT.CAPTURE.REFUNDED';
    const paypalId = event.event_type === 'PAYMENT.CAPTURE.REFUNDED' ? undefined : resource?.supplementary_data?.related_ids?.order_id ?? (!captureEvent && typeof resource?.id === 'string' ? resource.id : undefined);
    if (typeof paypalId === 'string') {
      const attempt = await db.paymentAttempt.findUnique({ where: { paypalOrderId: paypalId } });
      if (attempt && attempt.workspaceId === workspaceId) {
        const paypalOrder = await paypal.request(`/v2/checkout/orders/${encodeURIComponent(paypalId)}`, 'GET');
        const localOrderRecord = await db.order.findUniqueOrThrow({ where: { id: attempt.orderId }, select: { reference: true } });
        const purchase = paypalOrder.purchase_units?.find((p: any) => p.reference_id === localOrderRecord.reference);
        if (purchase?.custom_id !== attempt.orderId || purchase.amount?.currency_code !== attempt.currency || purchase.amount?.value !== paypalAmount(attempt.amountMinor, attempt.currency)) throw new Error('Webhook PayPal order does not match local order');
        const captures = purchase.payments?.captures ?? [];
        const capture = captureEvent ? captures.find((item: any) => item.id === resource?.id) : undefined;
        const eventType = event.event_type as string;
        await db.$transaction(async tx => {
          const current = await tx.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
          const localOrder = await tx.order.findUniqueOrThrow({ where: { id: current.orderId } });
          if (captureEvent && capture) {
            if (capture.amount?.currency_code !== current.currency || capture.amount?.value !== paypalAmount(current.amountMinor, current.currency)) throw new Error('Webhook capture amount does not match local order');
            if (capture.status === 'COMPLETED' && localOrder.status !== 'REFUNDED') {
              await tx.paymentAttempt.update({ where: { id: current.id }, data: { status: 'CAPTURED', captureId: capture.id, lastErrorCode: null } });
              await tx.order.update({ where: { id: current.orderId }, data: { status: 'PAID' } });
              await tx.auditEvent.create({ data: { workspaceId, action: 'payment.webhook_captured', entityType: 'paymentAttempt', entityId: current.id } });
            } else if (capture.status === 'DENIED' && !['CAPTURED','REFUNDED'].includes(current.status)) {
              await tx.paymentAttempt.update({ where: { id: current.id }, data: { status: 'DENIED', lastErrorCode: 'PAYPAL_CAPTURE_DENIED' } });
              if (localOrder.status === 'AWAITING_PAYMENT') await tx.order.update({ where: { id: current.orderId }, data: { status: 'PAYMENT_FAILED' } });
            } else if (capture.status === 'PENDING' && !['CAPTURED','REFUNDED'].includes(current.status)) {
              await tx.paymentAttempt.update({ where: { id: current.id }, data: { status: 'UNCERTAIN', lastErrorCode: 'PAYPAL_CAPTURE_PENDING' } });
            } else if (capture.status === 'REFUNDED' && current.status === 'CAPTURED') {
              await tx.paymentAttempt.update({ where: { id: current.id }, data: { status: 'REFUNDED', lastErrorCode: 'PAYPAL_CAPTURE_REFUNDED' } });
              await tx.order.update({ where: { id: current.orderId }, data: { status: 'REFUNDED' } });
            }
          } else if (eventType === 'CHECKOUT.ORDER.APPROVED' && current.status === 'CREATED') {
            await tx.paymentAttempt.update({ where: { id: current.id }, data: { status: 'APPROVED' } });
          } else if (eventType === 'CHECKOUT.ORDER.VOIDED' && localOrder.status === 'AWAITING_PAYMENT' && current.status !== 'CAPTURED') {
            await tx.paymentAttempt.update({ where: { id: current.id }, data: { status: 'CANCELLED' } });
            await tx.order.update({ where: { id: current.orderId }, data: { status: 'CANCELLED' } });
          }
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      }
    }
    await db.webhookEvent.updateMany({ where: { workspaceId, eventId: event.id }, data: { processedAt: new Date() } });
    return { received: true, duplicate: false };
  });

  api.get('/api/v1/workspaces/:workspaceId/dashboard', async (request: any) => {
    const { membership } = await requireWorkspace(app, request, request.params.workspaceId);
    const [counts, captured, refunds, paymentStates, awaiting, recent] = await Promise.all([
      db.order.groupBy({ by: ['status'], where: { workspaceId: membership.workspaceId }, _count: { _all: true } }),
      db.paymentAttempt.aggregate({ where: { workspaceId: membership.workspaceId, status: { in: ['CAPTURED','REFUNDED'] } }, _sum: { amountMinor: true }, _count: { _all: true } }),
      db.refund.aggregate({ where: { workspaceId: membership.workspaceId, status: 'COMPLETED' }, _sum: { amountMinor: true }, _count: { _all: true } }),
      db.paymentAttempt.groupBy({ by: ['status'], where: { workspaceId: membership.workspaceId }, _count: { _all: true }, _sum: { amountMinor: true } }),
      db.order.aggregate({ where: { workspaceId: membership.workspaceId, status: 'AWAITING_PAYMENT' }, _sum: { totalMinor: true }, _count: { _all: true } }),
      db.auditEvent.findMany({ where: { workspaceId: membership.workspaceId }, orderBy: { createdAt: 'desc' }, take: 20, select: { action: true, entityType: true, entityId: true, createdAt: true } })
    ]);
    const grossCapturedMinor = captured._sum.amountMinor ?? 0;
    const completedRefundMinor = refunds._sum.amountMinor ?? 0;
    return { ordersByStatus: Object.fromEntries(counts.map(x => [x.status, x._count._all])), capturedPayments: { totalMinor: grossCapturedMinor, count: captured._count._all }, completedRefunds: { totalMinor: completedRefundMinor, count: refunds._count._all }, netPaidMinor: grossCapturedMinor - completedRefundMinor, paymentAttemptsByStatus: Object.fromEntries(paymentStates.map(x => [x.status, { count: x._count._all, totalMinor: x._sum.amountMinor ?? 0 }])), awaitingPayments: { count: awaiting._count._all, totalMinor: awaiting._sum.totalMinor ?? 0 }, awaitingPaymentOrders: awaiting._count._all, recentActivity: recent };
  });
  return app;
}
