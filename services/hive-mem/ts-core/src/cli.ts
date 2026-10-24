import { acquireWriterLock } from "./writer-lock.js";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { qdrantPersistenceFromEnv } from "./persistence.js";
import { createHiveMemHandler } from "./server.js";
import { InMemoryHiveMemStore } from "./store.js";

function readPort(): number {
  const raw = process.env.HIVEMEM_TS_CORE_PORT ?? process.env.HIVEMEM_WEB_PORT ?? process.env.PORT ?? "18790";
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return port;
}

const host = process.env.HIVEMEM_TS_CORE_HOST ?? "127.0.0.1";
const port = readPort();
process.env.HIVEMEM_STORAGE_PATH ??= "/var/opt/hivemem";
const releaseWriter = await acquireWriterLock(`${process.env.HIVEMEM_STORAGE_PATH}/writer.lock`);
process.once("exit", releaseWriter);
const persistence = qdrantPersistenceFromEnv();
const snapshot = persistence ? await persistence.load() : null;
const store = new InMemoryHiveMemStore({ ...(snapshot ? { snapshot } : {}), ...(persistence ? { persistence } : {}) });
const workerEnabled = process.env.HIVEMEM_WORKER_ENABLED !== "false";
store.configureWorker(workerEnabled);
store.recoverInterruptedJobs();
await store.flushPersistence();
const handler = createHiveMemHandler({
  store,
  revocationFilePath: process.env.HIVEMEM_REVOCATION_FILE ?? `${process.env.HIVEMEM_STORAGE_PATH ?? "/var/opt/hivemem"}/revoked-tokens.json`,
});
const certFile = process.env.HIVEMEM_TS_TLS_CERT_FILE ?? process.env.HIVEMEM_TLS_CERT_FILE;
const keyFile = process.env.HIVEMEM_TS_TLS_KEY_FILE ?? process.env.HIVEMEM_TLS_KEY_FILE;
const server: Server = certFile && keyFile ? createHttpsServer({ cert: readFileSync(certFile), key: readFileSync(keyFile) }, handler) : createHttpServer(handler);

const worker = workerEnabled ? setInterval(() => { void store.workerTick().catch(() => {}); }, 1000) : null;
worker?.unref();
const recovery = setInterval(() => store.retryPersistence(), 5000);
recovery.unref();
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;

server.listen(port, host, () => {
  const mode = persistence ? "qdrant" : "memory";
  const protocol = certFile && keyFile ? "https" : "http";
  console.log(`HiveMem TS core listening on ${protocol}://${host}:${port} (persistence: ${mode})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(recovery);
    if (worker) clearInterval(worker);
    server.close(() => {
      store.flushPersistence().then(() => process.exit(0), () => process.exit(1));
    });
  });
}
