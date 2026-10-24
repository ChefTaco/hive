import 'dotenv/config'
import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4200),
  HOST: z.string().default('0.0.0.0'),
  MAX_REQUEST_BODY_BYTES: z.coerce.number().int().min(1024).max(10 * 1024 * 1024).default(1024 * 1024),
  TRUSTED_PROXY_IPS: z.string().default(''),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  REDIS_PREFIX: z.string().default('hive-iam'),

  JWT_PRIVATE_KEY_PATH: z.string().min(1),
  JWT_PUBLIC_KEY_PATH: z.string().min(1),
  JWT_PREVIOUS_PUBLIC_KEY_PATHS: z.string().default(''),
  JWT_ISSUER: z.string().default('https://hive:4200'),
  JWT_ACCESS_TTL: z.coerce.number().default(900),
  JWT_REFRESH_TTL: z.coerce.number().default(604800),

  COOKIE_SECRET: z.string().min(32),

  TLS_CERT_PATH: z.string().optional(),
  TLS_KEY_PATH: z.string().optional(),

  CORS_ORIGIN: z.string().default('https://localhost'),

  AUDIT_LOG_DIR: z.string().optional(),
  AUDIT_MAX_AGE_DAYS: z.coerce.number().default(365),
  AUDIT_FLUSH_INTERVAL_MS: z.coerce.number().default(5000),
  AUDIT_BATCH_SIZE: z.coerce.number().default(100),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(900000),
  RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().default(5),

  IAM_AGENT_SECRET: z.string().min(16),
})

export type Env = z.infer<typeof envSchema>

function parseEnv(): Env {
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    console.error('❌ Invalid environment variables:')
    for (const issue of result.error.issues) {
      console.error(`   ${issue.path.join('.')}: ${issue.message}`)
    }
    process.exit(1)
  }
  return result.data
}

export const env = parseEnv()
