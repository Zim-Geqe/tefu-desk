import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { prisma } from './db.js';
import { hashToken } from './security.js';

declare module 'fastify' { interface FastifyRequest { userId?: string } }

export async function authenticate(app: FastifyInstance, request: FastifyRequest, db: PrismaClient = prisma): Promise<string> {
  const token = request.cookies.tefo_session;
  if (!token) throw (app as any).httpErrors.unauthorized();
  const session = await db.session.findUnique({ where: { tokenHash: hashToken(token) }, select: { userId: true, expiresAt: true } });
  if (!session || session.expiresAt <= new Date()) throw (app as any).httpErrors.unauthorized();
  request.userId = session.userId;
  return session.userId;
}

export async function workspaceFor(userId: string, workspaceId: string, db: PrismaClient = prisma) {
  return db.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId } }, select: { workspaceId: true, role: true } });
}

export function authorizedWorkspaceId(membership: { workspaceId: string } | null, requestedWorkspaceId: string): string | null {
  return membership?.workspaceId === requestedWorkspaceId ? membership.workspaceId : null;
}

export async function requireWorkspace(app: FastifyInstance, request: FastifyRequest, workspaceId: string, db: PrismaClient = prisma) {
  const userId = await authenticate(app, request, db);
  const membership = await workspaceFor(userId, workspaceId, db);
  if (!membership || !authorizedWorkspaceId(membership, workspaceId)) throw (app as any).httpErrors.notFound('Workspace not found');
  return { userId, membership };
}
