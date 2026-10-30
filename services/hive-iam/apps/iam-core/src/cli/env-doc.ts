import { IAM_VERSION } from '../config/version.js'
import { DEFAULT_PORT, HEALTH_PATH, PACKAGE_NAME, REDIS_DOCKER_COMMAND } from './constants.js'

export interface EnvVarDoc {
  name: string
  required: boolean
  secret: boolean
  default?: string
  generate?: 'hex32' | 'base64url32'
  description: string
}

/**
 * What a fresh install needs, for `hive-iam-server env-schema`. The launcher
 * uses this to write env files and generate secrets. Tuning knobs (TTLs, rate
 * limits, audit batching) are left out; they keep their built-in defaults.
 */
export const ENV_VARS: EnvVarDoc[] = [
  { name: 'COOKIE_SECRET', required: true, secret: true, generate: 'hex32', description: 'Session cookie signing secret, at least 32 characters. Keep it stable across restarts.' },
  { name: 'IAM_AGENT_SECRET', required: true, secret: true, generate: 'hex32', description: 'Shared secret for agent audit ingest (x-agent-token), at least 16 characters.' },
  { name: 'SEED_ADMIN_PASSWORD', required: false, secret: true, generate: 'base64url32', description: 'Password of the initial SUPER_ADMIN account, at least 16 characters. Used only on first start (empty database); if unset, one is generated and written to initial-credentials.env (mode 0600) next to the database.' },
  { name: 'SEED_ADMIN_USERNAME', required: false, secret: false, default: 'admin', description: 'Username of the initial SUPER_ADMIN account (first start only).' },
  { name: 'SEED_ADMIN_EMAIL', required: false, secret: false, default: 'admin@iam.local', description: 'Email of the initial SUPER_ADMIN account (first start only).' },
  { name: 'SEED_HIVE_ROUTER_CLIENT_SECRET', required: false, secret: true, generate: 'hex32', description: 'Secret of the built-in hive-router OIDC client, at least 32 characters; give Hive Router the same value as HIVE_ROUTER_IAM_CLIENT_SECRET. First start only; generated into initial-credentials.env if unset.' },
  { name: 'SEED_HIVE_CLIENT_SECRET', required: false, secret: true, generate: 'hex32', description: 'Secret of the built-in hive control-plane client, at least 32 characters. First start only; generated into initial-credentials.env if unset.' },
  { name: 'SEED_HIVE_PUBLIC_URL', required: false, secret: false, description: 'Public URL of the Hive console (for example https://hive.example.com). Sets the redirect URIs of the built-in clients on first start.' },
  { name: 'SEED_HIVE_ROUTER_REDIRECT_URI', required: false, secret: false, description: 'OIDC callback of Hive Router. Defaults to ${SEED_HIVE_PUBLIC_URL}/api/auth/oidc/callback.' },
  { name: 'JWT_ISSUER', required: false, secret: false, default: 'hive-iam', description: 'Issuer (iss) of the tokens IAM signs. Hive Router expects hive-iam unless HIVE_ROUTER_IAM_ISSUER says otherwise.' },
  { name: 'CORS_ORIGIN', required: false, secret: false, default: 'https://localhost', description: 'Comma-separated browser origins allowed to call IAM, usually the Hive console URL.' },
  { name: 'PORT', required: false, secret: false, default: String(DEFAULT_PORT), description: 'Listen port.' },
  { name: 'HOST', required: false, secret: false, default: '127.0.0.1', description: 'Listen address. Use 0.0.0.0 to accept connections from other hosts (the Docker image does).' },
  { name: 'TLS_CERT_PATH', required: false, secret: false, description: 'PEM certificate (chain) for HTTPS. Set together with TLS_KEY_PATH; without both, IAM serves plain HTTP.' },
  { name: 'TLS_KEY_PATH', required: false, secret: false, description: 'PEM private key for HTTPS.' },
  { name: 'HIVE_HOME', required: false, secret: false, default: '~/.hive', description: 'Base directory for Hive data. IAM keeps its data in $HIVE_HOME/iam.' },
  { name: 'IAM_DATA_DIR', required: false, secret: false, default: '${HIVE_HOME}/iam', description: 'IAM data directory (SQLite database, signing keys, audit logs). Created with mode 0700.' },
  { name: 'DATABASE_URL', required: false, secret: false, default: 'file:${IAM_DATA_DIR}/iam.db', description: 'SQLite database file. Created and migrated automatically on start.' },
  { name: 'JWT_PRIVATE_KEY_PATH', required: false, secret: false, default: '${IAM_DATA_DIR}/keys/iam-private.pem', description: 'RS256 signing private key (PEM). When this and JWT_PUBLIC_KEY_PATH are both unset, a 4096-bit pair is generated on first start.' },
  { name: 'JWT_PUBLIC_KEY_PATH', required: false, secret: false, default: '${IAM_DATA_DIR}/keys/iam-public.pem', description: 'RS256 signing public key (PEM), published through JWKS.' },
  { name: 'AUDIT_LOG_DIR', required: false, secret: false, default: '${IAM_DATA_DIR}/audit-logs', description: 'Directory for the append-only daily JSONL audit files.' },
  { name: 'REDIS_URL', required: false, secret: false, default: 'redis://localhost:6379', description: 'Redis connection URL (queues, rate limits, WebAuthn ceremonies). Use redis://:PASSWORD@host:6379 when Redis requires a password.' },
  { name: 'REDIS_PREFIX', required: false, secret: false, default: 'hive-iam', description: 'Key prefix in Redis, so IAM can share a Redis instance.' },
  { name: 'WEBAUTHN_RP_ID', required: false, secret: false, default: 'localhost', description: 'WebAuthn relying-party ID: the host name users see, for example hive.example.com.' },
  { name: 'WEBAUTHN_RP_ORIGIN', required: false, secret: false, default: 'https://localhost', description: 'WebAuthn expected origin, for example https://hive.example.com.' },
  { name: 'NODE_ENV', required: false, secret: false, default: 'production', description: 'Runtime mode.' },
]

export function buildEnvSchemaDocument() {
  return {
    service: 'iam',
    package: PACKAGE_NAME,
    version: IAM_VERSION,
    defaultPort: DEFAULT_PORT,
    healthPath: HEALTH_PATH,
    dependencies: [
      {
        name: 'redis',
        envVar: 'REDIS_URL',
        default: 'redis://localhost:6379',
        docker: REDIS_DOCKER_COMMAND,
      },
    ],
    env: ENV_VARS,
  }
}
