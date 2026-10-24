import { config as loadDotEnv } from 'dotenv';
import { resolve } from 'node:path';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { z } from 'zod';
import { assertStaticExporterFallbackAllowed } from '../security/static-exporter-fallback.js';

const envPath = resolve(process.cwd(), '.env');
const secretEnvPath = resolve(process.cwd(), '.env.apikeys');

loadDotEnv({ path: envPath });
if (existsSync(secretEnvPath)) {
  loadDotEnv({ path: secretEnvPath, override: true });
}

const portSchema = z.coerce.number().int().min(1).max(65535);
const byteLimitSchema = z.coerce.number().int().min(1024);
const optionalUrlSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().url().optional(),
);
const optionalSecretSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(24).optional(),
);
const optionalProxyTokenSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(8).optional(),
);
const booleanStringSchema = z
  .string()
  .optional()
  .transform((value) => value === 'true');

const defaultIamProxyScopes = [
  'iam:policy:write',
  'iam:users:read',
  'iam:users:write',
  'iam:users:delete',
  'iam:roles:read',
  'iam:roles:write',
  'iam:sa:read',
  'iam:sa:write',
  'iam:sa:delete',
  'iam:clients:read',
  'iam:clients:write',
  'iam:audit:read',
  'iam:sessions:revoke',
  'iam:system:login',
  'iam:tokens:introspect',
].join(' ');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  HOST: z.string().default('127.0.0.1'),
  API_HOST: z.string().optional(),
  ADMIN_HOST: z.string().optional(),
  API_PORT: portSchema.default(443),
  ADMIN_PORT: portSchema.default(9443),
  PUBLIC_API_URL: z.string().url().default('https://localhost:443'),
  PUBLIC_ADMIN_URL: z.string().url().default('https://localhost:9443'),
  HIVE_UI_PUBLIC_URL: z.string().url().default('https://localhost:9443'),
  HIVE_SKILLS_INTERNAL_URL: z.string().url().optional(),
  HIVE_SKILLS_PUBLIC_URL: z.string().url().optional(),
  HIVEMEM_INTERNAL_URL: z.string().url().default('http://127.0.0.1:18790'),
  HIVEMEM_PUBLIC_URL: z.string().url().default('https://localhost:9443'),
  HIVEMEM_CA_CERT_PATH: z.string().optional(),
  HIVE_ROUTER_MEMORY_PROXY_TOKEN: optionalProxyTokenSchema,
  HIVE_IAM_INTERNAL_URL: z.string().url().default('http://127.0.0.1:4200'),
  HIVE_IAM_PUBLIC_URL: z.string().url().default('https://localhost:9443/iam'),
  HIVE_STATUS_ALLOW_INSECURE_TLS: booleanStringSchema.default('false'),
  HIVE_ROUTER_AUTH_MODE: z.enum(['os', 'iam-oidc']).default('os'),
  HIVE_ROUTER_IAM_CLIENT_ID: z.string().min(1).default('hive-router'),
  HIVE_ROUTER_IAM_CLIENT_SECRET: optionalSecretSchema,
  HIVE_ROUTER_IAM_REDIRECT_URI: optionalUrlSchema,
  HIVE_ROUTER_IAM_SCOPES: z.string().default('openid profile email'),
  HIVE_ROUTER_IAM_PROXY_SCOPES: z.string().default(defaultIamProxyScopes),
  HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS: booleanStringSchema.default('false'),
  HIVE_ROUTER_IAM_CA_CERT_PATH: z.string().optional(),
  HIVE_ROUTER_IAM_JWKS_REFRESH_MS: z.coerce.number().int().min(1_000).default(5 * 60_000),
  HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS: z.coerce.number().int().min(1_000).default(15 * 60_000),
  HIVE_ROUTER_IAM_ISSUER: z.string().min(1).default('hive-iam'),
  HIVE_ROUTER_IAM_AUDIENCE: z.string().min(1).default('hive-router'),
  DATABASE_URL: z.string().startsWith('file:').default('file:./data/router.db'),
  DATA_DIR: z.string().default('./data'),
  TRACE_DIR: z.string().default('./data/traces'),
  TLS_CERT_PATH: z.string().optional(),
  TLS_KEY_PATH: z.string().optional(),
  REQUIRE_TLS: booleanStringSchema,
  HIVE_ROUTER_SECRET: z.string().min(32),
  HIVE_ROUTER_ADMIN_USERS: z.string().default('admin'),
  HIVE_ROUTER_OS_AUTH_COMMAND: z.string().optional(),
  HIVE_ROUTER_METRICS_TOKEN: optionalSecretSchema,
  HIVE_ROUTER_SECURITY_EXPORT_TOKEN_HASH: z.string().optional(),
  HIVE_ROUTER_SECURITY_EXPORT_STATIC_FALLBACK_ENABLED: booleanStringSchema.default('false'),
  HIVE_ROUTER_CLI_TOKEN: z.string().optional(),
  SEED_CLIENT_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  HIVE_TYPESAFE_AI_KEY: z.string().trim().min(1).optional(),
  HIVE_TYPESAFE_AI_MODEL: z.string().trim().min(1).default("jev-latest"),
  HIVE_ROUTER_OPENROUTER_KEY: z.string().trim().min(1).optional(),
  HIVE_ROUTER_DECISION_MODEL: z.string().min(1).default("~typesafe/jev-latest"),
  HIVE_ROUTER_DECISION_MODE: z.enum(["off", "shadow"]).default("shadow"),
  HIVE_ROUTER_DECISION_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrlSchema,
  PROMETHEUS_PREFIX: z.string().default('hive_router_'),
  DEFAULT_TRACE_RETENTION_DAYS: z.coerce.number().int().min(1).default(7),
  MAX_REQUEST_BODY_BYTES: byteLimitSchema.default(64 * 1024 * 1024),
  MAX_ADMIN_BODY_BYTES: byteLimitSchema.default(2 * 1024 * 1024),
  MAX_TRACE_BODY_BYTES: byteLimitSchema.default(1024 * 1024),
  CAPTURE_BINARY_MEDIA: booleanStringSchema,
  CAPTURE_REQUEST_BODIES: booleanStringSchema.default('false'),
  CAPTURE_RESPONSE_BODIES: booleanStringSchema.default('false'),
}).transform((env) => ({
  ...env,
  API_HOST: env.API_HOST ?? env.HOST,
  ADMIN_HOST: env.ADMIN_HOST ?? env.HOST,
  DATA_DIR: resolve(process.cwd(), env.DATA_DIR),
  TRACE_DIR: resolve(process.cwd(), env.TRACE_DIR),
  TLS_CERT_PATH: env.TLS_CERT_PATH ? resolve(process.cwd(), env.TLS_CERT_PATH) : undefined,
  TLS_KEY_PATH: env.TLS_KEY_PATH ? resolve(process.cwd(), env.TLS_KEY_PATH) : undefined,
  HIVE_ROUTER_IAM_REDIRECT_URI: env.HIVE_ROUTER_IAM_REDIRECT_URI ?? `${env.PUBLIC_ADMIN_URL.replace(/\/$/, '')}/api/auth/oidc/callback`,
  HIVE_ROUTER_IAM_CA_CERT_PATH: env.HIVE_ROUTER_IAM_CA_CERT_PATH
    ? resolve(process.cwd(), env.HIVE_ROUTER_IAM_CA_CERT_PATH)
    : undefined,
}));

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

export function loadEnv(): Env {
  if (cachedEnv) {
    return cachedEnv;
  }

  const env = envSchema.parse(process.env);
  mkdirSync(env.DATA_DIR, { recursive: true });
  mkdirSync(env.TRACE_DIR, { recursive: true });
  chmodSync(env.DATA_DIR, 0o700);
  chmodSync(env.TRACE_DIR, 0o700);

  if (env.TLS_CERT_PATH && !existsSync(env.TLS_CERT_PATH)) {
    throw new Error(`TLS certificate not found at ${env.TLS_CERT_PATH}`);
  }

  if (env.TLS_KEY_PATH && !existsSync(env.TLS_KEY_PATH)) {
    throw new Error(`TLS key not found at ${env.TLS_KEY_PATH}`);
  }

  if (env.HIVE_ROUTER_IAM_CA_CERT_PATH && !existsSync(env.HIVE_ROUTER_IAM_CA_CERT_PATH)) {
    throw new Error(`IAM CA certificate not found at ${env.HIVE_ROUTER_IAM_CA_CERT_PATH}`);
  }

  if (env.HIVEMEM_CA_CERT_PATH && !existsSync(env.HIVEMEM_CA_CERT_PATH)) {
    throw new Error(`HiveMem CA certificate not found at ${env.HIVEMEM_CA_CERT_PATH}`);
  }

  if (env.HIVE_ROUTER_IAM_JWKS_REFRESH_MS > env.HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS) {
    throw new Error('HIVE_ROUTER_IAM_JWKS_REFRESH_MS must not exceed HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS');
  }

  if (env.HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS && env.NODE_ENV === 'production') {
    throw new Error('HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS is forbidden in production');
  }

  if (env.HIVE_STATUS_ALLOW_INSECURE_TLS && env.NODE_ENV === 'production') {
    throw new Error('HIVE_STATUS_ALLOW_INSECURE_TLS is forbidden in production');
  }

  assertStaticExporterFallbackAllowed(env.HIVE_ROUTER_SECURITY_EXPORT_STATIC_FALLBACK_ENABLED);

  if ((env.NODE_ENV === 'production' || env.REQUIRE_TLS) && (!env.TLS_CERT_PATH || !env.TLS_KEY_PATH)) {
    throw new Error('TLS_CERT_PATH and TLS_KEY_PATH are required when NODE_ENV=production or REQUIRE_TLS=true');
  }

  if (env.HIVE_ROUTER_AUTH_MODE === 'iam-oidc' && !env.HIVE_ROUTER_IAM_CLIENT_SECRET) {
    throw new Error('HIVE_ROUTER_IAM_CLIENT_SECRET is required when HIVE_ROUTER_AUTH_MODE=iam-oidc');
  }

  cachedEnv = env;
  return env;
}
