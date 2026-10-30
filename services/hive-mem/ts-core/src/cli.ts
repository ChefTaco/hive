#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { envSchema, packageVersion, PACKAGE_NAME, probeQdrant, redactUrl, resolveConfig, storageStatus, type ServerConfig } from "./config.js";
import { qdrantPersistenceFromEnv } from "./persistence.js";
import { createHiveMemHandler } from "./server.js";
import { InMemoryHiveMemStore } from "./store.js";
import { acquireWriterLock } from "./writer-lock.js";

const BIN = "hivemem-server";

/** A failure the operator can fix; printed as a single line without a stack trace. */
class CliError extends Error {}

const USAGE = `Usage: ${BIN} [command] [options]

HiveMem shared memory server for agents (${PACKAGE_NAME}).

Commands:
  start        Start the server (default)
  check        Validate configuration and check that Qdrant is reachable; exits 0 or 1
  env-schema   Print the supported environment variables as JSON

Options:
  --env-file <path>  Load environment variables from a dotenv file before reading
                     configuration (repeatable; variables already set win)
  -h, --help         Show this help
  -v, --version      Print the version

Required: HIVEMEM_JWT_SECRET (generate one with \`openssl rand -hex 32\`).
Data is stored in Qdrant (HIVEMEM_QDRANT_URL, default http://127.0.0.1:6333); set
HIVEMEM_TS_PERSISTENCE=memory for a throwaway server whose data is lost on exit.
Run \`${BIN} env-schema\` for every supported variable.`;

interface ParsedArgs {
  command: "start" | "check" | "env-schema" | "help" | "version";
  envFiles: string[];
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const envFiles: string[] = [];
  let command: ParsedArgs["command"] | undefined;
  let flag: "help" | "version" | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--env-file") {
      const path = argv[index + 1];
      if (!path || path.startsWith("-")) throw new CliError("--env-file requires a path");
      envFiles.push(path);
      index += 1;
    } else if (arg.startsWith("--env-file=")) {
      const path = arg.slice("--env-file=".length);
      if (!path) throw new CliError("--env-file requires a path");
      envFiles.push(path);
    } else if (arg === "-h" || arg === "--help" || arg === "help") {
      flag ??= "help";
    } else if (arg === "-v" || arg === "--version") {
      flag ??= "version";
    } else if (arg.startsWith("-")) {
      throw new CliError(`unknown option ${arg}; run \`${BIN} --help\``);
    } else if (command === undefined && (arg === "start" || arg === "check" || arg === "env-schema")) {
      command = arg;
    } else {
      throw new CliError(`unknown command ${arg}; run \`${BIN} --help\``);
    }
  }
  return { command: flag ?? command ?? "start", envFiles };
}

function loadEnvFiles(paths: readonly string[]): void {
  for (const path of paths) {
    try {
      // Node's loader never overrides variables that are already set.
      process.loadEnvFile(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new CliError(`cannot load --env-file ${path}: ${code === "ENOENT" ? "file not found" : (error as Error).message}`);
    }
  }
}

function hasFlock(): boolean {
  const result = spawnSync("flock", ["--version"], { stdio: "ignore" });
  return !result.error;
}

function describeListener(config: ServerConfig): string {
  return `${config.tls ? "https" : "http"}://${config.host}:${config.port}`;
}

async function runCheck(): Promise<number> {
  const { config, problems } = resolveConfig();
  const lines: Array<[ok: boolean | null, text: string]> = [];
  for (const problem of problems) lines.push([false, problem]);
  if (!problems.some((problem) => problem.startsWith("HIVEMEM_JWT_SECRET"))) lines.push([true, "HIVEMEM_JWT_SECRET is set"]);
  lines.push([null, `listen ${describeListener(config)}${config.tls ? ` (certificate ${config.tls.certFile})` : " (plain HTTP)"}`]);
  const storage = storageStatus(config.storagePath);
  lines.push([storage.ok, `storage ${storage.detail}`]);
  lines.push(hasFlock() ? [true, "flock is available for single-writer protection"] : [false, "the flock command is missing; install util-linux (Linux) or a flock package (macOS)"]);
  if (config.persistence === "qdrant") {
    const probe = await probeQdrant(config.qdrantUrl, config.qdrantApiKey);
    lines.push([probe.ok, probe.detail]);
  } else {
    lines.push([null, "persistence: memory (volatile, all data is lost when the server stops); Qdrant not required"]);
  }
  lines.push([null, config.semantic ? "semantic embeddings: configured (endpoint not probed)" : "semantic embeddings: not configured (deterministic lexical retrieval)"]);

  const failures = lines.filter(([ok]) => ok === false).length;
  console.log(`${PACKAGE_NAME} ${packageVersion()} configuration check`);
  for (const [ok, text] of lines) console.log(`  ${ok === true ? "ok  " : ok === false ? "FAIL" : "info"}  ${text}`);
  console.log(failures === 0 ? "Result: ready to start" : `Result: ${failures} problem${failures === 1 ? "" : "s"} found`);
  return failures === 0 ? 0 : 1;
}

async function runStart(): Promise<void> {
  const { config, problems } = resolveConfig();
  if (problems.length > 0) throw new CliError(problems.join(`\n${BIN}: `));

  // Downstream modules (recovery journal, revocation list) read the storage root from the environment.
  process.env.HIVEMEM_STORAGE_PATH = config.storagePath;
  try {
    mkdirSync(config.storagePath, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new CliError(`cannot create storage directory ${config.storagePath} (${(error as NodeJS.ErrnoException).code ?? "error"}); set HIVEMEM_STORAGE_PATH to a writable directory`);
  }
  let releaseWriter: () => void;
  try {
    releaseWriter = await acquireWriterLock(`${config.storagePath}/writer.lock`);
  } catch (error) {
    throw new CliError(`${(error as Error).message} (lock ${config.storagePath}/writer.lock)`);
  }
  process.once("exit", releaseWriter);

  let persistence = null;
  if (config.persistence === "qdrant") {
    const probe = await probeQdrant(config.qdrantUrl, config.qdrantApiKey);
    if (!probe.ok) throw new CliError(probe.detail);
    persistence = qdrantPersistenceFromEnv({ ...process.env, HIVEMEM_TS_PERSISTENCE: "qdrant" });
  } else {
    console.warn(`${BIN}: HIVEMEM_TS_PERSISTENCE=memory: data is kept in memory only and is lost when the server stops`);
  }
  let snapshot = null;
  try {
    snapshot = persistence ? await persistence.load() : null;
  } catch (error) {
    throw new CliError(`cannot load data from Qdrant at ${redactUrl(config.qdrantUrl)}: ${(error as Error).message}`);
  }
  const store = new InMemoryHiveMemStore({ ...(snapshot ? { snapshot } : {}), ...(persistence ? { persistence } : {}) });
  const workerEnabled = process.env.HIVEMEM_WORKER_ENABLED !== "false";
  store.configureWorker(workerEnabled);
  store.recoverInterruptedJobs();
  await store.flushPersistence();
  const handler = createHiveMemHandler({
    store,
    revocationFilePath: process.env.HIVEMEM_REVOCATION_FILE ?? `${config.storagePath}/revoked-tokens.json`,
  });
  const server: Server = config.tls
    ? createHttpsServer({ cert: readFileSync(config.tls.certFile), key: readFileSync(config.tls.keyFile) }, handler)
    : createHttpServer(handler);

  const worker = workerEnabled ? setInterval(() => { void store.workerTick().catch(() => {}); }, 1000) : null;
  worker?.unref();
  const recovery = setInterval(() => store.retryPersistence(), 5000);
  recovery.unref();
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;

  server.once("error", (error: NodeJS.ErrnoException) => {
    const reason = error.code === "EADDRINUSE" ? "the port is already in use" : error.code === "EACCES" ? "permission denied" : error.message;
    console.error(`${BIN}: cannot listen on ${config.host}:${config.port}: ${reason}; set HIVEMEM_WEB_PORT or HIVEMEM_TS_CORE_HOST`);
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    console.log(`HiveMem TS core listening on ${describeListener(config)} (persistence: ${persistence ? "qdrant" : "memory"})`);
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
}

async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.command === "help") {
    console.log(USAGE);
    return;
  }
  if (args.command === "version") {
    console.log(packageVersion());
    return;
  }
  if (args.command === "env-schema") {
    console.log(JSON.stringify(envSchema(), null, 2));
    return;
  }
  loadEnvFiles(args.envFiles);
  if (args.command === "check") {
    process.exitCode = await runCheck();
    return;
  }
  await runStart();
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${BIN}: ${message}`);
  if (!(error instanceof CliError) && process.env.HIVEMEM_DEBUG === "true" && error instanceof Error) console.error(error.stack);
  process.exit(1);
}
