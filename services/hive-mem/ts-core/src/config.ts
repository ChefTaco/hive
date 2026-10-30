import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isUsableSigningSecret } from "./auth.js";
import { ADMIN_SCOPE, ISSUE_TOKEN_DEFAULT_TTL_SECONDS, ISSUE_TOKEN_MAX_TTL_SECONDS, ISSUE_TOKEN_MIN_TTL_SECONDS, TOKEN_ROLES } from "./issue-token.js";
import { qdrantUrlFromEnv } from "./persistence.js";
import { semanticConfig } from "./semantic-index.js";

export const PACKAGE_NAME = "@hivemagnus/hivemem-server";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 18790;
export const HEALTH_PATH = "/v1/health/ready";
export const DEFAULT_QDRANT_URL = "http://127.0.0.1:6333";
export const QDRANT_IMAGE = "qdrant/qdrant:v1.18.1";
export const QDRANT_DOCKER_COMMAND = `docker run -d --name hive-qdrant -p 127.0.0.1:6333:6333 -v hive-qdrant:/qdrant/storage ${QDRANT_IMAGE}`;
const GENERATE_HINT = "generate one with `openssl rand -hex 32`";

export type PersistenceMode = "qdrant" | "memory";

export interface ServerConfig {
  host: string;
  port: number;
  /** Absolute storage root for the writer lock, recovery journal, and revocation list. */
  storagePath: string;
  storagePathSource: "HIVEMEM_STORAGE_PATH" | "HIVE_HOME" | "home";
  persistence: PersistenceMode;
  qdrantUrl: string;
  qdrantApiKey?: string;
  tls: { certFile: string; certVar: string; keyFile: string; keyVar: string } | null;
  semantic: boolean;
}

export interface ResolvedConfig {
  config: ServerConfig;
  /** One line per problem, each naming the variable and how to fix it. Empty means the config is usable. */
  problems: string[];
}

function present(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** `${HIVE_HOME:-~/.hive}/memory`, used when HIVEMEM_STORAGE_PATH is unset. */
export function defaultStoragePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(present(env.HIVE_HOME) ? expandHome(env.HIVE_HOME) : join(homedir(), ".hive"), "memory");
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const problems: string[] = [];

  const jwtSecret = env.HIVEMEM_JWT_SECRET;
  if (!present(jwtSecret)) problems.push(`HIVEMEM_JWT_SECRET is not set; ${GENERATE_HINT}.`);
  else if (!isUsableSigningSecret(jwtSecret)) problems.push(`HIVEMEM_JWT_SECRET must be at least 32 bytes and not a placeholder; ${GENERATE_HINT}.`);
  const renewalSecret = env.HIVEMEM_RENEWAL_SECRET;
  if (present(renewalSecret) && (Buffer.byteLength(renewalSecret) < 32 || renewalSecret === jwtSecret)) {
    problems.push(`HIVEMEM_RENEWAL_SECRET must be at least 32 bytes and differ from HIVEMEM_JWT_SECRET; ${GENERATE_HINT}, or unset it to disable token renewal.`);
  }
  if (present(env.HIVEMEM_METRICS_TOKEN) && env.HIVEMEM_METRICS_TOKEN.length < 32) {
    problems.push(`HIVEMEM_METRICS_TOKEN must be at least 32 characters; ${GENERATE_HINT}, or unset it.`);
  }

  const portVar = ["HIVEMEM_TS_CORE_PORT", "HIVEMEM_WEB_PORT", "PORT"].find((name) => present(env[name]));
  let port = DEFAULT_PORT;
  if (portVar) {
    const raw = env[portVar] ?? "";
    const parsed = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) port = parsed;
    else problems.push(`${portVar} must be a port number between 1 and 65535 (got "${raw}").`);
  }
  const host = present(env.HIVEMEM_TS_CORE_HOST) ? env.HIVEMEM_TS_CORE_HOST : DEFAULT_HOST;

  const rawMode = env.HIVEMEM_TS_PERSISTENCE;
  let persistence: PersistenceMode = "qdrant";
  if (rawMode === "memory") persistence = "memory";
  else if (present(rawMode) && rawMode !== "qdrant") {
    problems.push(`HIVEMEM_TS_PERSISTENCE must be "qdrant" (the default) or "memory" (volatile: all data is lost when the server stops); got "${rawMode}".`);
  }

  const storagePathSource: ServerConfig["storagePathSource"] = present(env.HIVEMEM_STORAGE_PATH) ? "HIVEMEM_STORAGE_PATH" : present(env.HIVE_HOME) ? "HIVE_HOME" : "home";
  const storagePath = present(env.HIVEMEM_STORAGE_PATH) ? resolve(expandHome(env.HIVEMEM_STORAGE_PATH)) : defaultStoragePath(env);

  const certVar = present(env.HIVEMEM_TS_TLS_CERT_FILE) ? "HIVEMEM_TS_TLS_CERT_FILE" : "HIVEMEM_TLS_CERT_FILE";
  const keyVar = present(env.HIVEMEM_TS_TLS_KEY_FILE) ? "HIVEMEM_TS_TLS_KEY_FILE" : "HIVEMEM_TLS_KEY_FILE";
  const certFile = env[certVar];
  const keyFile = env[keyVar];
  let tls: ServerConfig["tls"] = null;
  if (present(certFile) && present(keyFile)) {
    tls = { certFile, certVar, keyFile, keyVar };
    for (const [name, path] of [[certVar, certFile], [keyVar, keyFile]] as const) {
      try {
        accessSync(path, constants.R_OK);
      } catch (error) {
        problems.push(`${name} points to ${path}, which cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"}); fix the path or unset both TLS variables to serve plain HTTP.`);
      }
    }
  } else if (present(certFile) || present(keyFile)) {
    problems.push(`Set both HIVEMEM_TLS_CERT_FILE and HIVEMEM_TLS_KEY_FILE to serve HTTPS, or neither to serve plain HTTP; only ${present(certFile) ? certVar : keyVar} is set.`);
  }

  const qdrantUrl = qdrantUrlFromEnv(env);
  if (persistence === "qdrant") {
    try {
      const parsed = new URL(qdrantUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
    } catch {
      problems.push(`HIVEMEM_QDRANT_URL must be an http(s) URL such as ${DEFAULT_QDRANT_URL} (got "${qdrantUrl}").`);
    }
  }

  let semantic = false;
  try {
    semantic = semanticConfig(env) !== null;
  } catch (error) {
    problems.push(`HIVEMEM_EMBEDDING_ENDPOINT is set but the embedding config is invalid: ${(error as Error).message}. Set HIVEMEM_EMBEDDING_MODEL, HIVEMEM_EMBEDDING_REVISION, HIVEMEM_EMBEDDING_DIMENSIONS and HIVEMEM_SEMANTIC_COLLECTION (hivemem_shadow_*), or unset HIVEMEM_EMBEDDING_ENDPOINT.`);
  }

  const config: ServerConfig = {
    host,
    port,
    storagePath,
    storagePathSource,
    persistence,
    qdrantUrl,
    ...(present(env.QDRANT_API_KEY) ? { qdrantApiKey: env.QDRANT_API_KEY } : {}),
    tls,
    semantic,
  };
  return { config, problems };
}

/** Removes any user:password component before a URL is printed. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
    }
    return parsed.href.replace(/\/$/, "");
  } catch {
    return url;
  }
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

/** Read-only Qdrant reachability probe (GET /collections). Never creates or writes anything. */
export async function probeQdrant(url: string, apiKey: string | undefined, timeoutMs = 5000, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  const target = redactUrl(url);
  try {
    const response = await fetchImpl(url.replace(/\/$/, "") + "/collections", {
      headers: { accept: "application/json", ...(apiKey ? { "api-key": apiKey } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      return { ok: false, detail: `Qdrant at ${target} rejected the request (HTTP ${response.status}); check QDRANT_API_KEY.` };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, detail: `Qdrant at ${target} answered HTTP ${response.status}; check HIVEMEM_QDRANT_URL.` };
    }
    const body = (await response.json().catch(() => null)) as { result?: { collections?: unknown[] } } | null;
    const count = Array.isArray(body?.result?.collections) ? body.result.collections.length : null;
    return { ok: true, detail: `Qdrant reachable at ${target}${count === null ? "" : ` (${count} collection${count === 1 ? "" : "s"})`}` };
  } catch (error) {
    const failure = (error as { cause?: { code?: string; message?: string } }).cause;
    const cause = failure?.code ?? failure?.message ?? (error as Error).name ?? "error";
    return {
      ok: false,
      detail: `Cannot reach Qdrant at ${target} (${cause}). Start one with \`${QDRANT_DOCKER_COMMAND}\`, point HIVEMEM_QDRANT_URL at yours, or set HIVEMEM_TS_PERSISTENCE=memory for a throwaway server whose data is lost on exit.`,
    };
  }
}

/** Describes how the storage path will behave without creating it. */
export function storageStatus(path: string): ProbeResult {
  if (existsSync(path)) {
    try {
      if (!statSync(path).isDirectory()) return { ok: false, detail: `${path} exists but is not a directory; set HIVEMEM_STORAGE_PATH to a directory.` };
      accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK);
      return { ok: true, detail: `${path} (exists, writable)` };
    } catch {
      return { ok: false, detail: `${path} is not writable by this user; fix its permissions or set HIVEMEM_STORAGE_PATH.` };
    }
  }
  let parent = dirname(path);
  while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
  try {
    accessSync(parent, constants.W_OK | constants.X_OK);
    return { ok: true, detail: `${path} (will be created with mode 0700)` };
  } catch {
    return { ok: false, detail: `${path} does not exist and ${parent} is not writable; create it or set HIVEMEM_STORAGE_PATH.` };
  }
}

export function packageVersion(): string {
  for (const candidate of ["../../package.json", "../package.json"]) {
    try {
      const parsed = JSON.parse(readFileSync(new URL(candidate, import.meta.url), "utf8")) as { name?: string; version?: string };
      if (parsed.name === PACKAGE_NAME && parsed.version) return parsed.version;
    } catch {
      // Try the next layout (built dist/src or source src).
    }
  }
  return "0.0.0";
}

export interface EnvSchemaEntry {
  name: string;
  required: boolean;
  secret: boolean;
  default?: string;
  generate?: "hex32" | "base64url32";
  description: string;
}

export interface EnvSchema {
  service: "memory";
  package: string;
  version: string;
  defaultPort: number;
  healthPath: string;
  dependencies: Array<{ name: string; envVar: string; default: string; docker: string }>;
  /**
   * How to mint a bearer token for another service (for example Hive Router's
   * HIVE_ROUTER_MEMORY_PROXY_TOKEN): run this command with the same env file.
   * It prints only the token on stdout.
   */
  issueToken: {
    command: "issue-token";
    signedWith: "HIVEMEM_JWT_SECRET";
    roles: readonly string[];
    adminScope: string;
    defaultTtlSeconds: number;
    minTtlSeconds: number;
    maxTtlSeconds: number;
  };
  env: EnvSchemaEntry[];
}

export function envSchema(): EnvSchema {
  return {
    service: "memory",
    package: PACKAGE_NAME,
    version: packageVersion(),
    defaultPort: DEFAULT_PORT,
    healthPath: HEALTH_PATH,
    dependencies: [{ name: "qdrant", envVar: "HIVEMEM_QDRANT_URL", default: DEFAULT_QDRANT_URL, docker: QDRANT_DOCKER_COMMAND }],
    issueToken: {
      command: "issue-token",
      signedWith: "HIVEMEM_JWT_SECRET",
      roles: TOKEN_ROLES,
      adminScope: ADMIN_SCOPE,
      defaultTtlSeconds: ISSUE_TOKEN_DEFAULT_TTL_SECONDS,
      minTtlSeconds: ISSUE_TOKEN_MIN_TTL_SECONDS,
      maxTtlSeconds: ISSUE_TOKEN_MAX_TTL_SECONDS,
    },
    env: [
      { name: "HIVEMEM_JWT_SECRET", required: true, secret: true, generate: "hex32", description: "HS256 signing secret for agent and admin bearer tokens (at least 32 bytes). Rotating it invalidates every issued token." },
      { name: "HIVEMEM_RENEWAL_SECRET", required: false, secret: true, generate: "hex32", description: "Independent secret for long-lived token renewal grants (POST /v1/auth/renew). Must differ from HIVEMEM_JWT_SECRET; unset disables renewal." },
      { name: "HIVEMEM_TS_CORE_HOST", required: false, secret: false, default: DEFAULT_HOST, description: "Interface to listen on. Use 0.0.0.0 only behind TLS or a trusted proxy." },
      { name: "HIVEMEM_WEB_PORT", required: false, secret: false, default: String(DEFAULT_PORT), description: "TCP port to listen on (HIVEMEM_TS_CORE_PORT overrides it)." },
      { name: "HIVEMEM_STORAGE_PATH", required: false, secret: false, default: "${HIVE_HOME:-~/.hive}/memory", description: "Local state directory: writer lock, write-recovery journal, and token revocation list. Created with mode 0700." },
      { name: "HIVEMEM_TS_PERSISTENCE", required: false, secret: false, default: "qdrant", description: "\"qdrant\" stores data in Qdrant. \"memory\" is a volatile opt-in for tests and demos; all data is lost when the server stops." },
      { name: "HIVEMEM_QDRANT_URL", required: false, secret: false, default: DEFAULT_QDRANT_URL, description: "Qdrant REST base URL. Keep Qdrant bound to localhost or a private network." },
      { name: "QDRANT_API_KEY", required: false, secret: true, description: "API key sent to Qdrant, if your Qdrant requires one." },
      { name: "HIVEMEM_TLS_CERT_FILE", required: false, secret: false, description: "PEM certificate path. Set together with HIVEMEM_TLS_KEY_FILE to serve HTTPS; unset serves plain HTTP." },
      { name: "HIVEMEM_TLS_KEY_FILE", required: false, secret: false, description: "PEM private key path for HIVEMEM_TLS_CERT_FILE." },
      { name: "HIVEMEM_METRICS_TOKEN", required: false, secret: true, description: "Optional bearer token (at least 32 characters) for GET /metrics; without it /metrics needs an admin JWT." },
      { name: "HIVEMEM_EMBEDDING_ENDPOINT", required: false, secret: false, description: "Optional OpenAI-compatible /v1/embeddings URL (HTTPS, or HTTP on loopback) for a semantic shadow index. Requires the other HIVEMEM_EMBEDDING_* settings." },
      { name: "HIVEMEM_EMBEDDING_API_KEY", required: false, secret: true, description: "Bearer key for HIVEMEM_EMBEDDING_ENDPOINT, if it needs one." },
      { name: "HIVEMEM_EMBEDDING_MODEL", required: false, secret: false, description: "Embedding model name sent to HIVEMEM_EMBEDDING_ENDPOINT." },
      { name: "HIVEMEM_EMBEDDING_REVISION", required: false, secret: false, description: "Model revision label; changing it isolates vectors from a different model build." },
      { name: "HIVEMEM_EMBEDDING_DIMENSIONS", required: false, secret: false, description: "Embedding vector size returned by the model (1-8192)." },
      { name: "HIVEMEM_SEMANTIC_COLLECTION", required: false, secret: false, description: "Qdrant collection for the semantic shadow index; must start with hivemem_shadow_." },
    ],
  };
}
