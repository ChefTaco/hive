import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Output } from "../src/output.js";
import { hivePaths, type HivePaths } from "../src/paths.js";
import { SERVICES, type ServiceName } from "../src/services.js";

export function tempHome(prefix = "hive-test-"): { paths: HivePaths; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), prefix));
  return { paths: hivePaths({ HIVE_HOME: home }), cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export function recordingOutput(): Output & { lines: string[]; text: () => string } {
  const lines: string[] = [];
  const push = (prefix: string) => (line = "") => { lines.push(`${prefix}${line}`); };
  return {
    lines,
    text: () => lines.join("\n"),
    color: false,
    info: push(""),
    step: push("• "),
    ok: push("✓ "),
    warn: push("! "),
    error: push("✗ "),
    heading: push("## "),
  };
}

const SCHEMAS: Record<ServiceName, unknown> = {
  memory: {
    service: "memory", package: "@hivemagnus/hivemem-server", version: "1.0.0", defaultPort: 18790, healthPath: "/v1/health/ready",
    dependencies: [{ name: "qdrant", envVar: "HIVEMEM_QDRANT_URL", default: "http://127.0.0.1:6333", docker: "docker run -d --name hive-qdrant -p 127.0.0.1:6333:6333 -v hive-qdrant:/qdrant/storage qdrant/qdrant:v1.18.1" }],
    env: [
      { name: "HIVEMEM_JWT_SECRET", required: true, secret: true, generate: "hex32", description: "Signing secret." },
      { name: "HIVEMEM_RENEWAL_SECRET", required: false, secret: true, generate: "hex32", description: "Renewal secret." },
      { name: "HIVEMEM_WEB_PORT", required: false, secret: false, default: "18790", description: "Port." },
      { name: "HIVEMEM_QDRANT_URL", required: false, secret: false, default: "http://127.0.0.1:6333", description: "Qdrant URL." },
    ],
  },
  router: {
    service: "router", package: "@hivemagnus/hive-router", version: "1.0.0", defaultPort: 4020, adminPort: 9443, healthPath: "/health", readyPath: "/health/ready", consolePath: "/",
    dependencies: [],
    env: [
      { name: "HIVE_ROUTER_SECRET", required: true, secret: true, generate: "hex32", description: "Session secret." },
      { name: "HIVE_ROUTER_METRICS_TOKEN", required: false, secret: true, generate: "hex32", description: "Metrics token." },
      { name: "HIVE_ROUTER_IAM_CLIENT_SECRET", required: false, secret: true, generate: "hex32", description: "IAM client secret." },
      { name: "HIVE_ROUTER_MEMORY_PROXY_TOKEN", required: false, secret: true, description: "HiveMem token." },
    ],
  },
  iam: {
    service: "iam", package: "@hivemagnus/hive-iam-server", version: "1.0.0", defaultPort: 4200, healthPath: "/api/v1/health/ready",
    dependencies: [{ name: "redis", envVar: "REDIS_URL", default: "redis://localhost:6379", docker: "docker run -d --name hive-redis -p 127.0.0.1:6379:6379 redis:7.4.7-alpine" }],
    env: [
      { name: "COOKIE_SECRET", required: true, secret: true, generate: "hex32", description: "Cookie secret." },
      { name: "IAM_AGENT_SECRET", required: true, secret: true, generate: "hex32", description: "Agent secret." },
      { name: "SEED_ADMIN_PASSWORD", required: false, secret: true, generate: "base64url32", description: "Admin password." },
      { name: "SEED_HIVE_ROUTER_CLIENT_SECRET", required: false, secret: true, generate: "hex32", description: "Router client secret." },
    ],
  },
};

/**
 * A stand-in server bin: prints the schema, mints HS256 tokens, passes
 * `check`, and on `start` serves 200 on every path of its configured ports.
 * Events go to $HIVE_HOME/events.log; `$HIVE_HOME/crash-<service>` makes it
 * exit 3 shortly after it becomes healthy.
 */
function fakeBin(service: ServiceName): string {
  return `#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
const service = ${JSON.stringify(service)};
const schema = ${JSON.stringify(SCHEMAS[service])};
const args = process.argv.slice(2);
const envFile = args.find((arg) => arg.startsWith("--env-file="))?.slice("--env-file=".length);
if (envFile) process.loadEnvFile(envFile);
const command = args.find((arg) => !arg.startsWith("-")) ?? "start";
const log = (line) => appendFileSync(process.env.HIVE_HOME + "/events.log", line + "\\n");
if (command === "env-schema") { console.log(JSON.stringify(schema)); process.exit(0); }
if (command === "check") { console.log(args.includes("--json") ? JSON.stringify({ ok: true, checks: [] }) : "  ok    fake check"); process.exit(0); }
if (command === "issue-token") {
  const secret = process.env.HIVEMEM_JWT_SECRET;
  if (!secret) { console.error("hivemem-server: HIVEMEM_JWT_SECRET is not set"); process.exit(1); }
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = enc({ alg: "HS256", typ: "JWT" }) + "." + enc({ sub: "hive-router", role: "admin", scope: "admin:all", iat: now, exp: now + 30 * 86400, jti: randomUUID() });
  console.log(unsigned + "." + createHmac("sha256", secret).update(unsigned).digest("base64url"));
  log("issue-token");
  process.exit(0);
}
if (process.env.PORT_LEAK_CHECK) log("leaked " + process.env.PORT_LEAK_CHECK);
const ports = service === "router" ? [process.env.API_PORT, process.env.ADMIN_PORT] : [service === "memory" ? process.env.HIVEMEM_WEB_PORT : process.env.PORT];
const servers = ports.map((port) => createServer((request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end("{\\"status\\":\\"ok\\"}"); }).listen(Number(port), "127.0.0.1"));
log("start " + service + " token=" + (process.env.HIVE_ROUTER_MEMORY_PROXY_TOKEN ? "yes" : "no"));
console.log(service + " listening on " + ports.join(","));
if (existsSync(process.env.HIVE_HOME + "/crash-" + service)) setTimeout(() => { log("crash " + service); process.exit(3); }, 700);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { log("stop " + service + " " + signal); for (const server of servers) server.close(); process.exit(0); });
`;
}

export function installFakeServers(paths: HivePaths, services: readonly ServiceName[] = ["memory", "router", "iam"]): void {
  for (const service of services) {
    const definition = SERVICES[service];
    const root = join(paths.runtime, "node_modules", ...definition.packageName.split("/"));
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: definition.packageName, version: "1.0.0", type: "module", bin: { [definition.bin]: "bin/cli.js" } }));
    writeFileSync(join(root, "bin", "cli.js"), fakeBin(service), { mode: 0o755 });
  }
}

export async function listen(server: Server | ReturnType<typeof createNetServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("no address");
  return address.port;
}

/** A local stand-in for Qdrant's REST API. */
export async function fakeQdrant(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createHttpServer((request, response) => {
    response.writeHead(request.url === "/collections" ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify({ result: { collections: [] }, status: "ok" }));
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** A local stand-in that answers Redis PING. */
export async function fakeRedis(reply = "+PONG\r\n"): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  const server = createNetServer((socket) => socket.on("data", () => socket.write(reply)));
  const port = await listen(server);
  return { url: `redis://127.0.0.1:${port}`, port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

export async function freePort(): Promise<number> {
  const server = createNetServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
