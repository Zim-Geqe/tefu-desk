import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

if (existsSync('.env')) loadEnvFile('.env');
const { prisma } = await import('../src/db.js');

try {
  await prisma.$connect();
  console.log(await prisma.$queryRaw`SELECT current_database() AS database, current_user AS role`);
} finally {
  await prisma.$disconnect();
}
