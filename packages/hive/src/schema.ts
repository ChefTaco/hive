import { CliError } from "./errors.js";
import type { HivePaths } from "./paths.js";
import { runServerCommand, type InstalledServer } from "./runtime.js";
import { SERVICES, type ServiceName } from "./services.js";

/** One entry of a server's `env-schema` output. */
export interface SchemaVar {
  name: string;
  required: boolean;
  secret: boolean;
  default?: string;
  generate?: "hex32" | "base64url32";
  description: string;
}

export interface StoreDependency {
  name: string;
  envVar: string;
  default: string;
  docker: string;
}

/** The parts of `<server> env-schema` the launcher relies on. */
export interface ServerSchema {
  service: ServiceName;
  package: string;
  version: string;
  defaultPort: number;
  adminPort?: number;
  healthPath: string;
  readyPath?: string;
  consolePath?: string;
  /** memory and iam: their store (Qdrant, Redis) with a docker one-liner. */
  stores: StoreDependency[];
  env: SchemaVar[];
  raw: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates the shape we depend on, naming the field when a server is too old or too new. */
export function parseServerSchema(service: ServiceName, text: string): ServerSchema {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CliError(`${SERVICES[service].bin} env-schema did not print JSON; reinstall it with \`hive install ${service}\``);
  }
  const fail = (field: string): never => {
    throw new CliError(`${SERVICES[service].bin} env-schema has no valid "${field}"; this launcher may not match the installed server version (run \`hive install ${service}\`)`);
  };
  if (!isRecord(raw)) return fail("document");
  if (raw.service !== service) fail("service");
  if (typeof raw.defaultPort !== "number") fail("defaultPort");
  if (typeof raw.healthPath !== "string") fail("healthPath");
  if (!Array.isArray(raw.env)) fail("env");
  const env: SchemaVar[] = [];
  for (const entry of raw.env as unknown[]) {
    if (!isRecord(entry) || typeof entry.name !== "string") fail("env");
    const item = entry as Record<string, unknown>;
    env.push({
      name: item.name as string,
      required: item.required === true,
      secret: item.secret === true,
      ...(typeof item.default === "string" ? { default: item.default } : {}),
      ...(item.generate === "hex32" || item.generate === "base64url32" ? { generate: item.generate } : {}),
      description: typeof item.description === "string" ? item.description : "",
    });
  }
  const stores: StoreDependency[] = [];
  for (const dependency of Array.isArray(raw.dependencies) ? (raw.dependencies as unknown[]) : []) {
    if (isRecord(dependency) && typeof dependency.name === "string" && typeof dependency.envVar === "string" && typeof dependency.docker === "string" && typeof dependency.default === "string") {
      stores.push({ name: dependency.name, envVar: dependency.envVar, default: dependency.default, docker: dependency.docker });
    }
  }
  return {
    service,
    package: typeof raw.package === "string" ? raw.package : SERVICES[service].packageName,
    version: typeof raw.version === "string" ? raw.version : "0.0.0",
    defaultPort: raw.defaultPort as number,
    ...(typeof raw.adminPort === "number" ? { adminPort: raw.adminPort } : {}),
    healthPath: raw.healthPath as string,
    ...(typeof raw.readyPath === "string" ? { readyPath: raw.readyPath } : {}),
    ...(typeof raw.consolePath === "string" ? { consolePath: raw.consolePath } : {}),
    stores,
    env,
    raw,
  };
}

export function readServerSchema(paths: HivePaths, server: InstalledServer): ServerSchema {
  const result = runServerCommand(paths, server, ["env-schema"]);
  if (result.status !== 0) throw new CliError(`${SERVICES[server.service].bin} env-schema failed: ${result.stderr.trim().split("\n")[0] ?? `exit code ${result.status}`}`);
  return parseServerSchema(server.service, result.stdout);
}

export function schemaVar(schema: ServerSchema, name: string): SchemaVar | undefined {
  return schema.env.find((entry) => entry.name === name);
}
