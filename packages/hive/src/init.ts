import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { consoleUrl, DEFAULTS, listeners, mainListener, usesTls } from "./endpoints.js";
import { EnvDocument, ensurePrivateDir, writePrivateFile } from "./envfile.js";
import { CliError, UsageError } from "./errors.js";
import { isPortFree, nextFreePort } from "./net.js";
import { mask, type Output } from "./output.js";
import type { HivePaths } from "./paths.js";
import type { Prompter } from "./prompt.js";
import { installedServer, installServers, requireInstalled } from "./runtime.js";
import { readServerSchema, type ServerSchema } from "./schema.js";
import { parseServiceList, SERVICE_NAMES, SERVICES, sortServices, type ServiceName } from "./services.js";
import { readState, writeState, type LauncherState } from "./state.js";
import { resolveStore } from "./stores.js";
import { certificateNames, createCertificates, inspectServerCertificate, namesOnCertificate, OPENSSL_MISSING, opensslVersion, tlsFiles, type TlsFiles } from "./tls.js";
import { describeTokenProblem, MEMORY_TOKEN_VAR, memoryTokenProblem, mintMemoryToken, tokenExpiry } from "./token.js";
import { launcherMajor, majorOf } from "./version.js";
import { displayUrl } from "./privacy.js";

export const PORT_KEYS = ["memory", "iam", "router", "router-admin", "qdrant", "redis"] as const;
export type PortKey = (typeof PORT_KEYS)[number];

export interface InitOptions {
  services?: ServiceName[] | undefined;
  hostname?: string | undefined;
  tls: boolean;
  from?: string | undefined;
  ports: Partial<Record<PortKey, number>>;
  qdrantUrl?: string | undefined;
  redisUrl?: string | undefined;
  dockerPrefix: string;
}

export interface InitContext {
  paths: HivePaths;
  output: Output;
  prompter: Prompter;
  options: InitOptions;
  platform?: NodeJS.Platform;
  /** Overridable for tests. */
  isFree?: (port: number) => Promise<boolean>;
  username?: string;
}

/** A value `init` wants in an env file. Wiring values are reconciled in existing files too. */
interface Entry {
  key: string;
  value: string;
  secret?: boolean;
  wiring?: boolean;
}

interface Plan {
  service: ServiceName;
  doc: EnvDocument;
  isNew: boolean;
  /** Keys that will change in an existing file: [key, old, new]. */
  changes: Array<[string, string | undefined, string]>;
}

const HOSTNAME_PATTERN = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/u;
const TOKEN_NOTE = "# HIVE_ROUTER_MEMORY_PROXY_TOKEN is minted by `hive init` and `hive start` with `hivemem-server issue-token`.";

function generate(kind: "hex32" | "base64url32" | undefined): string {
  return kind === "base64url32" ? randomBytes(32).toString("base64url") : randomBytes(32).toString("hex");
}

function header(service: ServiceName, paths: HivePaths): string[] {
  const { title, packageName, bin } = SERVICES[service];
  return [
    `# ${title} (${packageName}), written by \`hive init\` on ${new Date().toISOString().slice(0, 10)}.`,
    "# Keep this file private (mode 0600). `hive init` never overwrites values here without asking.",
    `# Run with \`hive start ${service}\`, or directly: ${bin} --env-file ${paths.envFile(service)}`,
    "",
  ];
}

/** Commented lines for the settings init leaves at their defaults, so the file documents itself. */
function optionalSettings(schema: ServerSchema, doc: EnvDocument): string[] {
  const values = doc.values();
  const lines: string[] = ["", `# Other settings (\`${SERVICES[schema.service].bin} env-schema\` lists them all):`];
  for (const entry of schema.env) {
    if (entry.name in values || entry.name === MEMORY_TOKEN_VAR) continue;
    lines.push(`# ${entry.description}`, `# ${entry.name}=${entry.default ?? ""}`);
  }
  return lines;
}

function existingInitialCredential(paths: HivePaths, iamEnv: EnvDocument | null, name: string): string | undefined {
  const dataDir = iamEnv?.get("IAM_DATA_DIR") ?? join(paths.home, "iam");
  const file = join(dataDir, "initial-credentials.env");
  if (!existsSync(file)) return undefined;
  try {
    return parseEnv(readFileSync(file, "utf8"))[name] || undefined;
  } catch {
    return undefined;
  }
}

function iamInitialized(paths: HivePaths, iamEnv: EnvDocument | null): boolean {
  const url = iamEnv?.get("DATABASE_URL");
  const dbPath = url ? url.replace(/^file:/u, "") : join(iamEnv?.get("IAM_DATA_DIR") ?? join(paths.home, "iam"), "iam.db");
  return existsSync(dbPath);
}

async function chooseServices(context: InitContext, configured: ServiceName[]): Promise<ServiceName[]> {
  const { output, prompter, options } = context;
  output.heading("Services");
  for (const name of SERVICE_NAMES) output.info(`  ${name.padEnd(7)} ${SERVICES[name].title}: ${SERVICES[name].summary}`);
  output.info("  Any combination works; the Router alone is valid. With IAM, console sign-in goes through IAM;");
  output.info("  without it, the Router checks OS passwords (Linux, needs pamtester).");
  if (options.services) return sortServices([...configured, ...options.services]);
  if (configured.length === 0) {
    const answer = await prompter.ask("Services to set up (comma-separated)", "memory,router,iam");
    try {
      const chosen = parseServiceList([answer]);
      if (chosen.length === 0) throw new Error("choose at least one service");
      return chosen;
    } catch (error) {
      throw new UsageError((error as Error).message);
    }
  }
  output.info(`  Already configured: ${configured.join(", ")}. Existing settings and secrets are kept.`);
  const selected = [...configured];
  for (const name of SERVICE_NAMES) {
    if (!configured.includes(name) && (await prompter.confirm(`Also set up ${name} (${SERVICES[name].title})?`, false))) selected.push(name);
  }
  return sortServices(selected);
}

async function ensureInstalled(context: InitContext, services: ServiceName[]): Promise<void> {
  const { paths, output, prompter, options } = context;
  const missing = services.filter((service) => !installedServer(paths, service));
  const mismatched = services.filter((service) => {
    const installed = installedServer(paths, service);
    return installed !== null && majorOf(installed.version) !== launcherMajor();
  });
  for (const service of mismatched) output.warn(`${SERVICES[service].packageName} ${installedServer(paths, service)?.version} does not match this launcher (major ${launcherMajor()}).`);
  const toInstall = sortServices([...missing, ...mismatched]);
  if (toInstall.length === 0) return;
  const installed = await installServers(paths, toInstall, { from: options.from, prompter, output, reason: "Hive needs these server packages" });
  if (!installed && missing.length > 0) {
    throw new CliError(`init cannot continue without ${missing.map((service) => SERVICES[service].packageName).join(", ")}; run \`hive install\` when you are ready, then \`hive init\` again`);
  }
}

async function prepareTls(context: InitContext, docs: Map<ServiceName, EnvDocument>): Promise<TlsFiles | null> {
  const { paths, output, prompter, options } = context;
  if (!options.tls) {
    if (options.hostname) throw new UsageError("--hostname needs TLS; drop --no-tls");
    output.warn("TLS is off (--no-tls): new services use plain HTTP and listen on 127.0.0.1 only.");
    return null;
  }
  if (!opensslVersion()) throw new CliError(OPENSSL_MISSING);
  const files = tlsFiles(paths);
  const previous = existsSync(files.cert) ? (() => { try { return namesOnCertificate(readFileSync(files.cert)); } catch { return []; } })() : [];
  const routerHost = docs.get("router")?.get("PUBLIC_ADMIN_URL");
  const names = [...new Set([...certificateNames(options.hostname), ...previous, ...(routerHost ? [new URL(routerHost).hostname] : [])])];
  const status = inspectServerCertificate(files, names);
  output.heading("TLS");
  if (status.state === "ok") {
    output.ok(`Using the certificates in ${paths.tls} (${names.join(", ")})`);
    return files;
  }
  if (status.state === "unusable") {
    if (!(await prompter.confirm(`Replace the server certificate in ${paths.tls}? (${status.reason}; the local CA is kept)`, true))) {
      output.warn(`Keeping the existing server certificate (${status.reason}).`);
      return files;
    }
  }
  const newCa = !existsSync(files.caCert) || !existsSync(files.caKey);
  createCertificates(paths, names, { newCa });
  output.ok(`${newCa ? "Created a local CA and a" : "Created a new"} server certificate for ${names.join(", ")} in ${paths.tls}`);
  return files;
}

async function allocatePorts(context: InitContext, newServices: ServiceName[], schemas: Map<ServiceName, ServerSchema>, docs: Map<ServiceName, EnvDocument>): Promise<Partial<Record<PortKey, number>>> {
  const { output, options } = context;
  const isFree = context.isFree ?? isPortFree;
  const taken = new Set<number>();
  for (const [service, doc] of docs) {
    if (!newServices.includes(service)) for (const entry of listeners(service, doc)) taken.add(entry.port);
  }
  const wanted: Array<[PortKey, number]> = [];
  for (const service of newServices) {
    const schema = schemas.get(service);
    if (service === "router") {
      wanted.push(["router", schema?.defaultPort ?? DEFAULTS.router.apiPort], ["router-admin", schema?.adminPort ?? DEFAULTS.router.adminPort]);
    } else {
      wanted.push([service, schema?.defaultPort ?? (service === "memory" ? DEFAULTS.memory.port : DEFAULTS.iam.port)]);
    }
  }
  const ports: Partial<Record<PortKey, number>> = {};
  for (const [key, fallback] of wanted) {
    const explicit = options.ports[key];
    if (explicit !== undefined) {
      if (taken.has(explicit)) throw new UsageError(`--port ${key}=${explicit} is already used by another Hive service`);
      if (!(await isFree(explicit))) throw new CliError(`port ${explicit} (--port ${key}) is already in use on this machine; choose another`);
      ports[key] = explicit;
    } else {
      const port = await nextFreePort(fallback, taken, isFree);
      if (port !== fallback) output.info(`  Port ${fallback} (${key}) is in use; using ${port}.`);
      ports[key] = port;
    }
    taken.add(ports[key] as number);
  }
  return ports;
}

function setAll(doc: EnvDocument, entries: readonly Entry[]): void {
  for (const entry of entries) doc.set(entry.key, entry.value);
}

/** Values a brand-new env file starts with. */
function baseEntries(service: ServiceName, context: InitContext, schema: ServerSchema, values: { ports: Partial<Record<PortKey, number>>; tls: TlsFiles | null; storeUrl?: string; routerClientSecret: string; osUser: string; publicHost: string }): Entry[] {
  const { paths, options } = context;
  const entries: Entry[] = [{ key: "HIVE_HOME", value: paths.home }];
  const secrets = schema.env.filter((entry) => entry.required && entry.secret && entry.generate).map((entry) => ({ key: entry.name, value: generate(entry.generate), secret: true }));
  if (service === "memory") {
    entries.push(...secrets, { key: "HIVEMEM_TS_CORE_HOST", value: "127.0.0.1" }, { key: "HIVEMEM_WEB_PORT", value: String(values.ports.memory) });
    if (values.storeUrl) entries.push({ key: "HIVEMEM_QDRANT_URL", value: values.storeUrl });
    if (values.tls) entries.push({ key: "HIVEMEM_TLS_CERT_FILE", value: values.tls.cert }, { key: "HIVEMEM_TLS_KEY_FILE", value: values.tls.key });
  } else if (service === "iam") {
    entries.push({ key: "NODE_ENV", value: "production" }, { key: "HOST", value: "127.0.0.1" }, { key: "PORT", value: String(values.ports.iam) }, ...secrets);
    if (values.storeUrl) entries.push({ key: "REDIS_URL", value: values.storeUrl });
    entries.push({ key: "JWT_ISSUER", value: "hive-iam" });
    if (values.tls) entries.push({ key: "TLS_CERT_PATH", value: values.tls.cert }, { key: "TLS_KEY_PATH", value: values.tls.key });
    // The admin password is left to IAM: it generates one on first start and
    // writes it to initial-credentials.env next to its database.
    entries.push({ key: "SEED_ADMIN_USERNAME", value: "admin" }, { key: "SEED_HIVE_ROUTER_CLIENT_SECRET", value: values.routerClientSecret, secret: true });
  } else {
    const scheme = values.tls ? "https" : "http";
    entries.push(
      { key: "NODE_ENV", value: values.tls ? "production" : "development" },
      ...secrets,
      { key: "HOST", value: options.hostname ? "0.0.0.0" : "127.0.0.1" },
      { key: "API_PORT", value: String(values.ports.router) },
      { key: "ADMIN_PORT", value: String(values.ports["router-admin"]) },
      { key: "PUBLIC_API_URL", value: `${scheme}://${values.publicHost}:${values.ports.router}` },
      { key: "PUBLIC_ADMIN_URL", value: `${scheme}://${values.publicHost}:${values.ports["router-admin"]}` },
    );
    if (values.tls) entries.push({ key: "TLS_CERT_PATH", value: values.tls.cert }, { key: "TLS_KEY_PATH", value: values.tls.key });
    entries.push({ key: "HIVE_ROUTER_AUTH_MODE", value: "os" }, { key: "HIVE_ROUTER_ADMIN_USERS", value: values.osUser });
  }
  return entries;
}

/** Cross-service values, derived from the other services' (final) env files. */
function wiringEntries(service: ServiceName, docs: Map<ServiceName, EnvDocument>, tls: TlsFiles | null, routerClientSecret: string): Entry[] {
  const router = docs.get("router");
  const iam = docs.get("iam");
  const memory = docs.get("memory");
  const entries: Entry[] = [];
  if (service === "router" && router) {
    const admin = consoleUrl(router).replace(/\/$/u, "");
    if (iam) {
      const iamListener = mainListener("iam", iam);
      entries.push(
        { key: "HIVE_ROUTER_AUTH_MODE", value: "iam-oidc" },
        { key: "HIVE_ROUTER_ADMIN_USERS", value: iam.get("SEED_ADMIN_USERNAME") ?? "admin" },
        { key: "HIVE_IAM_INTERNAL_URL", value: iamListener.url },
        { key: "HIVE_IAM_PUBLIC_URL", value: `${iamListener.tls ? "https" : "http"}://localhost:${iamListener.port}` },
        { key: "HIVE_ROUTER_IAM_CLIENT_ID", value: "hive-router" },
        { key: "HIVE_ROUTER_IAM_CLIENT_SECRET", value: routerClientSecret, secret: true },
        { key: "HIVE_ROUTER_IAM_REDIRECT_URI", value: `${admin}/api/auth/oidc/callback` },
        { key: "HIVE_ROUTER_IAM_ISSUER", value: iam.get("JWT_ISSUER") ?? "hive-iam" },
        { key: "HIVE_ROUTER_IAM_AUDIENCE", value: "hive-router" },
      );
      if (iamListener.tls && tls) entries.push({ key: "HIVE_ROUTER_IAM_CA_CERT_PATH", value: tls.caCert });
    }
    if (memory) {
      const memoryListener = mainListener("memory", memory);
      entries.push({ key: "HIVEMEM_INTERNAL_URL", value: memoryListener.url }, { key: "HIVEMEM_PUBLIC_URL", value: admin });
      if (memoryListener.tls && tls) entries.push({ key: "HIVEMEM_CA_CERT_PATH", value: tls.caCert });
    }
  }
  if (service === "iam" && iam && router) {
    const admin = consoleUrl(router).replace(/\/$/u, "");
    const publicHost = new URL(admin).hostname;
    entries.push(
      { key: "SEED_HIVE_PUBLIC_URL", value: admin },
      { key: "SEED_HIVE_ROUTER_REDIRECT_URI", value: `${admin}/api/auth/oidc/callback` },
      { key: "CORS_ORIGIN", value: admin },
      { key: "WEBAUTHN_RP_ID", value: publicHost },
      { key: "WEBAUTHN_RP_ORIGIN", value: admin },
    );
    if (!iam.has("SEED_HIVE_ROUTER_CLIENT_SECRET")) entries.push({ key: "SEED_HIVE_ROUTER_CLIENT_SECRET", value: routerClientSecret, secret: true });
  }
  return entries.map((entry) => ({ ...entry, wiring: true }));
}

function describeChange([key, before, after]: [string, string | undefined, string], secretKeys: ReadonlySet<string>): string {
  const show = (value: string) => secretKeys.has(key) ? mask(value) : /^[a-z][a-z0-9+.-]*:\/\//iu.test(value) ? displayUrl(value) : value;
  return before === undefined ? `add ${key}=${show(after)}` : `${key}: ${show(before)} -> ${show(after)}`;
}

export interface InitResult {
  services: ServiceName[];
  written: ServiceName[];
  consoleUrl: string | null;
}

export async function runInit(context: InitContext): Promise<InitResult> {
  const { paths, output, prompter, options } = context;
  const platform = context.platform ?? process.platform;
  if (options.hostname && !HOSTNAME_PATTERN.test(options.hostname)) throw new UsageError(`--hostname must be a DNS name such as hive.example.com (got "${options.hostname}")`);
  if (!/^[a-z0-9][a-z0-9_.-]{0,40}$/u.test(options.dockerPrefix)) throw new UsageError("--docker-prefix must be lowercase letters, digits, '.', '_' or '-'");

  output.info(`Hive setup in ${paths.home}`);
  ensurePrivateDir(paths.home);
  const configured = SERVICE_NAMES.filter((service) => existsSync(paths.envFile(service)));
  const services = await chooseServices(context, configured);
  const newServices = services.filter((service) => !configured.includes(service));
  if (services.includes("router") && !services.includes("iam")) {
    output.info(platform === "linux"
      ? `  Note: without IAM the console signs you in with your OS account (${context.username ?? userInfo().username}) through PAM; install pamtester (for example sudo apt install pamtester).`
      : "  Note: without IAM the console needs PAM sign-in, which works on Linux only. Add iam, or set HIVE_ROUTER_OS_AUTH_COMMAND in router.env.");
  }
  if (services.includes("router") && !services.includes("memory")) output.info("  Note: without memory the console's Memory pages stay empty.");

  await ensureInstalled(context, services);
  const schemas = new Map<ServiceName, ServerSchema>();
  for (const service of services) schemas.set(service, readServerSchema(paths, requireInstalled(paths, service)));

  const docs = new Map<ServiceName, EnvDocument>();
  for (const service of configured) docs.set(service, EnvDocument.load(paths.envFile(service)));
  const tls = await prepareTls(context, docs);

  output.heading("Ports");
  const ports = await allocatePorts(context, newServices, schemas, docs);
  for (const [key, port] of Object.entries(ports)) output.info(`  ${key.padEnd(13)} ${port}`);
  if (newServices.length === 0) output.info("  No new services; existing ports are kept.");

  const state: LauncherState = readState(paths);
  const storeContext = { output, prompter, state, dockerPrefix: options.dockerPrefix };
  const storeUrls: Partial<Record<ServiceName, string>> = {};
  for (const service of services) {
    const schema = schemas.get(service);
    const store = SERVICES[service].store;
    const dependency = schema?.stores.find((entry) => entry.name === store);
    if (!store || !dependency) continue;
    output.heading(store === "qdrant" ? "Qdrant (HiveMem storage)" : "Redis (IAM queues and rate limits)");
    const configuredUrl = docs.get(service)?.get(dependency.envVar);
    const explicit = store === "qdrant" ? options.qdrantUrl : options.redisUrl;
    try {
      storeUrls[service] = await resolveStore(storeContext, store, dependency, { url: explicit ?? configuredUrl, preferredPort: options.ports[store] });
    } catch (error) {
      throw new CliError((error as Error).message);
    }
  }

  // The Router's IAM client secret: IAM's value wins, since IAM may already have seeded it.
  const iamDoc = docs.get("iam") ?? null;
  const routerClientSecret = iamDoc?.get("SEED_HIVE_ROUTER_CLIENT_SECRET")
    ?? existingInitialCredential(paths, iamDoc, "SEED_HIVE_ROUTER_CLIENT_SECRET")
    ?? docs.get("router")?.get("HIVE_ROUTER_IAM_CLIENT_SECRET")
    ?? generate("hex32");
  if (iamDoc && !iamDoc.has("SEED_HIVE_ROUTER_CLIENT_SECRET") && iamInitialized(paths, iamDoc) && !existingInitialCredential(paths, iamDoc, "SEED_HIVE_ROUTER_CLIENT_SECRET") && services.includes("router")) {
    output.warn("IAM was initialized without a known hive-router client secret; set HIVE_ROUTER_IAM_CLIENT_SECRET in router.env to the hive-router client secret from IAM.");
  }

  const publicHost = options.hostname ?? "localhost";
  const plans: Plan[] = [];
  const secretKeys = new Set<string>([MEMORY_TOKEN_VAR]);
  for (const schema of schemas.values()) for (const entry of schema.env) if (entry.secret) secretKeys.add(entry.name);
  for (const service of newServices) {
    const schema = schemas.get(service) as ServerSchema;
    const doc = new EnvDocument();
    doc.append(...header(service, paths));
    const storeUrl = storeUrls[service];
    setAll(doc, baseEntries(service, context, schema, { ports, tls, ...(storeUrl ? { storeUrl } : {}), routerClientSecret, osUser: context.username ?? userInfo().username, publicHost }));
    docs.set(service, doc);
    plans.push({ service, doc, isNew: true, changes: [] });
  }
  for (const service of configured) {
    const doc = docs.get(service) as EnvDocument;
    const storeUrl = storeUrls[service];
    const store = SERVICES[service].store;
    const plan: Plan = { service, doc, isNew: false, changes: [] };
    if (storeUrl && store) {
      const key = store === "qdrant" ? "HIVEMEM_QDRANT_URL" : "REDIS_URL";
      if (doc.get(key) !== storeUrl) plan.changes.push([key, doc.get(key), storeUrl]);
    }
    plans.push(plan);
  }
  // Wiring is computed once every file holds its final ports and URLs.
  for (const plan of plans) {
    for (const entry of wiringEntries(plan.service, docs, tls, routerClientSecret)) {
      if (plan.isNew) plan.doc.set(entry.key, entry.value);
      else if (plan.doc.get(entry.key) !== entry.value) plan.changes.push([entry.key, plan.doc.get(entry.key), entry.value]);
    }
  }

  output.heading("Configuration");
  const written: ServiceName[] = [];
  for (const plan of plans) {
    const file = paths.envFile(plan.service);
    if (plan.isNew) {
      const schema = schemas.get(plan.service) as ServerSchema;
      if (plan.service === "router") plan.doc.append("", TOKEN_NOTE);
      plan.doc.append(...optionalSettings(schema, plan.doc));
      writePrivateFile(file, plan.doc.toString());
      written.push(plan.service);
      output.ok(`Wrote ${file} (mode 0600)`);
      continue;
    }
    if (plan.changes.length === 0) {
      output.ok(`${file} is up to date`);
      continue;
    }
    output.info(`  ${file} needs these changes to work with the other services:`);
    for (const change of plan.changes) output.info(`    ${describeChange(change, secretKeys)}`);
    if (await prompter.confirm(`Update ${plan.service}.env?`, true)) {
      for (const [key, , value] of plan.changes) plan.doc.set(key, value);
      writePrivateFile(file, plan.doc.toString());
      written.push(plan.service);
      output.ok(`Updated ${file}`);
      if (plan.service === "iam" && plan.changes.some(([key]) => key.startsWith("SEED_")) && iamInitialized(paths, plan.doc)) {
        output.warn("IAM is already initialized, so the SEED_* changes do not apply to its database. If console sign-in fails, update the hive-router client's redirect URI and secret in IAM.");
      }
    } else {
      output.warn(`Left ${file} unchanged; the services may not work together until it is updated.`);
    }
  }

  const router = docs.get("router");
  const memory = docs.get("memory");
  if (router && memory) {
    const problem = memoryTokenProblem(router, EnvDocument.load(paths.envFile("memory")));
    if (problem) {
      const token = mintMemoryToken(paths, requireInstalled(paths, "memory"));
      router.set(MEMORY_TOKEN_VAR, token);
      writePrivateFile(paths.envFile("router"), router.toString());
      const expires = new Date((tokenExpiry(token) ?? 0) * 1000).toISOString().slice(0, 10);
      output.ok(`Minted the Router's HiveMem admin token with hivemem-server issue-token (${describeTokenProblem(problem)}; new one expires ${expires}; \`hive start\` renews it)`);
    } else {
      output.ok("The Router's HiveMem admin token is valid");
    }
  }
  writeState(paths, state);

  summarize(context, services, docs, tls);
  return { services, written, consoleUrl: router ? displayUrl(consoleUrl(router)) : null };
}

function summarize(context: InitContext, services: ServiceName[], docs: Map<ServiceName, EnvDocument>, tls: TlsFiles | null): void {
  const { paths, output } = context;
  output.heading("Hive is configured");
  output.info(`  Config     ${paths.config}/{${services.join(",")}}.env`);
  output.info(`  Servers    ${paths.runtime}`);
  const dataDirs = services.map((service) => join(paths.home, service));
  output.info(`  Data       ${dataDirs.join(", ")}${dataDirs.some((dir) => !existsSync(dir)) ? " (created on first start)" : ""}`);
  if (tls) output.info(`  TLS        ${paths.tls} (local CA: ${tls.caCert})`);
  const router = docs.get("router");
  if (router) {
    output.info("");
    output.info(`  Console    ${displayUrl(consoleUrl(router))}`);
    if (usesTls("router", router)) output.info("             Your browser warns about the certificate until you trust the local CA above (or accept the warning once).");
    const iam = docs.get("iam");
    if (iam) {
      const credentials = join(iam.get("IAM_DATA_DIR") ?? join(paths.home, "iam"), "initial-credentials.env");
      if (iamInitialized(paths, iam)) {
        output.info(`  Sign in    as your IAM administrator (${iam.get("SEED_ADMIN_USERNAME") ?? "admin"}).${existsSync(credentials) ? ` The first password is in ${credentials}.` : ""}`);
      } else {
        output.info(`  Sign in    as ${iam.get("SEED_ADMIN_USERNAME") ?? "admin"}. IAM creates this account on its first start and writes`);
        output.info(`             the password to ${credentials} (mode 0600).`);
        output.info("             Change it after you sign in, then delete that file.");
      }
    } else {
      output.info(`  Sign in    with your OS account (${router.get("HIVE_ROUTER_ADMIN_USERS") ?? "see HIVE_ROUTER_ADMIN_USERS"}) and its password.`);
    }
  }
  output.info("");
  output.info("  Next:      hive start        (then `hive status` or `hive doctor` in another terminal)");
}
