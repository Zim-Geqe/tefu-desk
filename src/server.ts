import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

if (existsSync('.env')) loadEnvFile('.env');
const [{ loadConfig }, { buildApp }, { prisma }] = await Promise.all([
  import('./config.js'),
  import('./app.js'),
  import('./db.js')
]);
const config = loadConfig();
const app = await buildApp(config);
try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error({ err: error }, 'startup failed');
  await prisma.$disconnect();
  process.exit(1);
}
const shutdown = async () => { await app.close(); await prisma.$disconnect(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
