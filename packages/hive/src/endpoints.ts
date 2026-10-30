import { existsSync, readFileSync } from "node:fs";
import type { EnvDocument } from "./envfile.js";
import type { HivePaths } from "./paths.js";
import type { ServiceName } from "./services.js";
import { tlsFiles } from "./tls.js";

/** Default ports and health paths; they match each server's env-schema. */
export const DEFAULTS = {
  memory: { port: 18790, health: "/v1/health/ready" },
  iam: { port: 4200, health: "/api/v1/health/ready" },
  router: { apiPort: 4020, adminPort: 9443, health: "/health", ready: "/health/ready" },
} as const;

export interface Listener {
  service: ServiceName;
  /** `api` and `admin` for the Router, `main` otherwise. */
  plane: "main" | "api" | "admin";
  tls: boolean;
  /** Address to connect to locally (a wildcard bind address becomes loopback). */
  host: string;
  port: number;
  url: string;
  healthUrl: string;
}

function connectHost(bind: string | undefined): string {
  if (!bind || bind === "0.0.0.0" || bind === "::" || bind === "[::]" || bind === "localhost") return "127.0.0.1";
  return bind.includes(":") && !bind.startsWith("[") ? `[${bind}]` : bind;
}

function port(env: EnvDocument, names: readonly string[], fallback: number): number {
  for (const name of names) {
    const value = env.get(name);
    if (value && /^\d+$/u.test(value)) return Number(value);
  }
  return fallback;
}

function listener(service: ServiceName, plane: Listener["plane"], tls: boolean, host: string, portNumber: number, healthPath: string): Listener {
  const url = `${tls ? "https" : "http"}://${host}:${portNumber}`;
  return { service, plane, tls, host, port: portNumber, url, healthUrl: `${url}${healthPath}` };
}

export function usesTls(service: ServiceName, env: EnvDocument): boolean {
  if (service === "memory") return Boolean((env.get("HIVEMEM_TS_TLS_CERT_FILE") ?? env.get("HIVEMEM_TLS_CERT_FILE")) && (env.get("HIVEMEM_TS_TLS_KEY_FILE") ?? env.get("HIVEMEM_TLS_KEY_FILE")));
  return Boolean(env.get("TLS_CERT_PATH") && env.get("TLS_KEY_PATH"));
}

/** Where a configured service listens, read from its env file. */
export function listeners(service: ServiceName, env: EnvDocument): Listener[] {
  const tls = usesTls(service, env);
  if (service === "memory") {
    return [listener(service, "main", tls, connectHost(env.get("HIVEMEM_TS_CORE_HOST")), port(env, ["HIVEMEM_TS_CORE_PORT", "HIVEMEM_WEB_PORT", "PORT"], DEFAULTS.memory.port), DEFAULTS.memory.health)];
  }
  if (service === "iam") {
    return [listener(service, "main", tls, connectHost(env.get("HOST")), port(env, ["PORT"], DEFAULTS.iam.port), DEFAULTS.iam.health)];
  }
  const host = env.get("HOST");
  return [
    listener(service, "api", tls, connectHost(env.get("API_HOST") ?? host), port(env, ["API_PORT"], DEFAULTS.router.apiPort), DEFAULTS.router.health),
    listener(service, "admin", tls, connectHost(env.get("ADMIN_HOST") ?? host), port(env, ["ADMIN_PORT"], DEFAULTS.router.adminPort), DEFAULTS.router.health),
  ];
}

export function mainListener(service: ServiceName, env: EnvDocument): Listener {
  const all = listeners(service, env);
  return all.find((entry) => entry.plane === "admin") ?? (all[0] as Listener);
}

/** The console URL users open: PUBLIC_ADMIN_URL, or localhost on the admin port. */
export function consoleUrl(routerEnv: EnvDocument): string {
  const configured = routerEnv.get("PUBLIC_ADMIN_URL");
  if (configured) return `${configured.replace(/\/+$/u, "")}/`;
  const admin = mainListener("router", routerEnv);
  return `${admin.tls ? "https" : "http"}://localhost:${admin.port}/`;
}

/** The local CA, trusted when the launcher probes its own HTTPS services. */
export function launcherCa(paths: HivePaths): Buffer | undefined {
  const { caCert } = tlsFiles(paths);
  return existsSync(caCert) ? readFileSync(caCert) : undefined;
}
