import { z } from 'zod'

/**
 * Side-effect-free environment schema. `config/env.ts` parses `process.env`
 * with it at import time; the CLI validates with it before importing any
 * server module so configuration errors never surface as stack traces.
 */
export const envSchema = z.object({
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

const FIX_HINTS: Record<string, string> = {
  COOKIE_SECRET: 'set COOKIE_SECRET to a random string of at least 32 characters (for example `openssl rand -hex 32`)',
  IAM_AGENT_SECRET: 'set IAM_AGENT_SECRET to a random string of at least 16 characters (for example `openssl rand -hex 32`)',
  DATABASE_URL: 'set DATABASE_URL to a SQLite file URL such as file:/var/lib/hive-iam/iam.db',
  JWT_PRIVATE_KEY_PATH: 'set JWT_PRIVATE_KEY_PATH to the RS256 private key (PEM) file',
  JWT_PUBLIC_KEY_PATH: 'set JWT_PUBLIC_KEY_PATH to the RS256 public key (PEM) file',
}

type EnvIssue = z.core.$ZodIssue

function describeProblem(issue: EnvIssue, source: Record<string, string | undefined>, name: string): string {
  if (source[name] === undefined) return 'is not set'
  if (issue.code === 'too_small' && issue.origin === 'string') return `must contain at least ${String(issue.minimum)} characters`
  if (issue.code === 'too_small') return `must be at least ${String(issue.minimum)}`
  if (issue.code === 'too_big') return `must be at most ${String(issue.maximum)}`
  if (issue.code === 'invalid_value') return `must be one of ${issue.values.map(String).join(', ')}`
  if (issue.code === 'invalid_type' && issue.expected === 'number') return 'must be a number'
  return `is invalid (${issue.message})`
}

/**
 * One line per invalid variable: names the variable, the problem, and how to
 * fix it. Values are never echoed, because several of these are secrets.
 */
export function describeEnvIssues(
  issues: readonly EnvIssue[],
  source: Record<string, string | undefined> = process.env,
): string[] {
  const lines: string[] = []
  const seen = new Set<string>()
  for (const issue of issues) {
    const name = issue.path.map(String).join('.') || 'environment'
    if (seen.has(name)) continue
    seen.add(name)
    const hint = FIX_HINTS[name] ?? `set ${name} to a valid value`
    lines.push(`Configuration error: ${name} ${describeProblem(issue, source, name)}. Fix: ${hint} in the environment or env file.`)
  }
  return lines
}

export type EnvValidation =
  | { ok: true; env: Env }
  | { ok: false; errors: string[] }

export function validateEnv(source: Record<string, string | undefined> = process.env): EnvValidation {
  const result = envSchema.safeParse(source)
  if (result.success) return { ok: true, env: result.data }
  return { ok: false, errors: describeEnvIssues(result.error.issues, source) }
}
