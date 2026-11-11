import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

if (existsSync('.env')) loadEnvFile('.env');

if (process.env.NODE_ENV === 'production' || process.env.ALLOW_DEV_SEED !== 'true') {
  throw new Error('Development seeding requires ALLOW_DEV_SEED=true and NODE_ENV other than production');
}

const db = new PrismaClient();
const email = 'owner@example.test';
const passwordHash = await argon2.hash('passsword123!!!', { type: argon2.argon2id });

try {
  const user = await db.user.upsert({
    where: { email },
    create: { email, name: 'Demo Owner', passwordHash },
    update: { name: 'Demo Owner', passwordHash },
  });

  const ownedMembership = await db.membership.findFirst({ where: { userId: user.id, role: 'OWNER' }, select: { workspaceId: true } });
  const workspace = ownedMembership
    ? await db.workspace.findUniqueOrThrow({ where: { id: ownedMembership.workspaceId } })
    : await db.workspace.create({ data: { name: 'Tefo Demo Shop', memberships: { create: { userId: user.id, role: 'OWNER' } } } });

  await db.workspace.update({ where: { id: workspace.id }, data: { name: 'Tefo Demo Shop' } });
  await db.business.upsert({
    where: { workspaceId: workspace.id },
    create: { workspaceId: workspace.id, name: 'Tefo Demo Shop', currency: 'USD', email },
    update: { name: 'Tefo Demo Shop', currency: 'USD', email },
  });
  await db.aiSettings.upsert({ where: { workspaceId: workspace.id }, create: { workspaceId: workspace.id }, update: {} });

  const catalog = [
    { sku: 'DEMO-STARTER', name: 'Starter Workflow Pack', description: 'A practical automation starter package for a small online shop.', priceMinor: 12900 },
    { sku: 'DEMO-AUDIT', name: 'AI Operations Audit', description: 'A guided review of repetitive order and payment tasks.', priceMinor: 7900 },
    { sku: 'DEMO-SUPPORT', name: 'Monthly Desk Support', description: 'A month of order workflow setup and small-business support.', priceMinor: 24900 },
  ];
  const products = await Promise.all(catalog.map(item => db.product.upsert({
    where: { workspaceId_sku: { workspaceId: workspace.id, sku: item.sku } },
    create: { workspaceId: workspace.id, ...item, currency: 'USD', active: true },
    update: { ...item, currency: 'USD', active: true },
  })));

  // Retire the original ZAR-only fixture so the demo catalog stays coherent with its USD PayPal checkout.
  await db.product.updateMany({ where: { workspaceId: workspace.id, name: 'Development sample product' }, data: { active: false } });

  await db.order.upsert({
    where: { workspaceId_reference: { workspaceId: workspace.id, reference: 'DEMO-STARTER-001' } },
    create: {
      workspaceId: workspace.id,
      reference: 'DEMO-STARTER-001',
      customerName: 'Maya Chen',
      customerEmail: 'maya@example.test',
      customerRequest: 'I need the Starter Workflow Pack for my small online shop.',
      currency: 'USD',
      subtotalMinor: 12900,
      totalMinor: 12900,
      status: 'DRAFT',
      items: { create: { productId: products[0]!.id, descriptionSnapshot: products[0]!.name, skuSnapshot: products[0]!.sku, quantity: 1, unitPriceMinor: 12900, lineTotalMinor: 12900, currency: 'USD' } },
    },
    update: {},
  });

  console.log('Demo fixtures ready for local development. Sign in with owner@example.test / ChangeMe123456');
  console.log('The demo workspace uses USD and includes three catalog items plus a reviewable draft order.');
} finally {
  await db.$disconnect();
}
