import { createHash, randomBytes } from 'node:crypto';

export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return (awaitImportTimingSafeEqual)(left, right);
}
import { timingSafeEqual as awaitImportTimingSafeEqual } from 'node:crypto';
