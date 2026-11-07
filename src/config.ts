import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  APP_ORIGIN: z.string().url().default('http://localhost:3000'),
  COOKIE_SECURE: z.string().default('false').transform(v => v === 'true'),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  PAYPAL_ENV: z.enum(['sandbox', 'live']).default('sandbox'),
  PAYPAL_CLIENT_ID: z.string().optional().default(''),
  PAYPAL_CLIENT_SECRET: z.string().optional().default(''),
  PAYPAL_WEBHOOK_ID: z.string().optional().default(''),
  AI_PROVIDER: z.enum(['none', 'gemini', 'openai', 'compatible']).default('none'),
  AI_MODEL: z.string().optional().default(''),
  AI_API_KEY: z.string().optional().default(''),
  AI_BASE_URL: z.string().url().optional().or(z.literal('')).default(''),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info')
});

export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid environment configuration: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  if (parsed.data.AI_PROVIDER !== 'none' && (!parsed.data.AI_API_KEY || !parsed.data.AI_MODEL)) throw new Error('AI_API_KEY and AI_MODEL are required when AI_PROVIDER is enabled');
  if (parsed.data.AI_PROVIDER === 'compatible' && !parsed.data.AI_BASE_URL) throw new Error('AI_BASE_URL is required for compatible AI provider');
  if ((parsed.data.PAYPAL_CLIENT_ID && !parsed.data.PAYPAL_CLIENT_SECRET) || (!parsed.data.PAYPAL_CLIENT_ID && parsed.data.PAYPAL_CLIENT_SECRET)) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be configured together');
  if (parsed.data.NODE_ENV === 'production' && (!parsed.data.COOKIE_SECURE || !parsed.data.APP_ORIGIN.startsWith('https://'))) throw new Error('Production requires COOKIE_SECURE=true and an HTTPS APP_ORIGIN');
  return parsed.data;
}
