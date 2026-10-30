import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { rootCertificates } from "node:tls";
import { launcherCa, listeners, type Listener } from "./endpoints.js";
import { EnvDocument, writePrivateFile } from "./envfile.js";
import { CliError } from "./errors.js";
import { probeHttp } from "./net.js";
import { paint, type Color, type Output } from "./output.js";
import type { HivePaths } from "./paths.js";
import { envFileArgs, requireInstalled, serverEnvironment, type InstalledServer } from "./runtime.js";
import { SERVICES, sortServices, type ServiceName } from "./services.js";
import { readState } from "./state.js";
import { ensureStoreRunning } from "./stores.js";
import { describeTokenProblem, MEMORY_TOKEN_VAR, memoryTokenProblem, mintMemoryToken, tokenExpiry } from "./token.js";

const COLORS: Record<ServiceName, Color> = { iam: "magenta", memory: "yellow", router: "cyan" };
const STARTUP_TIMEOUT_MS: Record<ServiceName, number> = { iam: 180_000, memory: 90_000, router: 90_000 };
const STOP_TIMEOUT_MS = 20_000;
const TOKEN_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export interface StartOptions {
  services: ServiceName[];
  /** Seconds to wait for each health endpoint (overrides the per-service default). */
  timeoutSeconds?: number | undefined;
}

interface Running {
  service: ServiceName;
  child: ChildProcess;
  exited: Promise<number | null>;
  /** Set while the launcher itself stops or restarts this child. */
  expectedExit: boolean;
}

/** Trust the public roots plus the local CA when probing our own HTTPS listeners. */
export function probeCa(paths: HivePaths): string[] | undefined {
  const ca = launcherCa(paths);
  return ca ? [...rootCertificates, ca.toString("utf8")] : undefined;
}

export interface LauncherPid {
  pid: number;
  startedAt: string;
  services: Partial<Record<ServiceName, number>>;
}

export function readPidFile(paths: HivePaths): LauncherPid | null {
  if (!existsSync(paths.pidFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(paths.pidFile, "utf8")) as LauncherPid;
    return typeof parsed.pid === "number" ? parsed : null;
  } catch {
    return null;
  }
}

/** Is `pid` a running `hive` launcher? On Linux the command line is checked, so a reused pid does not count. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("start");
  } catch {
    return true;
  }
}

function prefixer(service: ServiceName, output: Output, stream: NodeJS.WritableStream): (chunk: Buffer) => void {
  const label = paint(`${service.padEnd(6)} │`, COLORS[service], output.color);
  let pending = "";
  return (chunk) => {
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) stream.write(`${label} ${line}\n`);
  };
}

async function waitHealthy(entries: Listener[], ca: string[] | undefined, timeoutMs: number, running: Running): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  for (const entry of entries) {
    for (;;) {
      if (running.child.exitCode !== null || running.child.signalCode !== null) {
        throw new CliError(`${running.service} exited during startup (${running.child.exitCode !== null ? `exit code ${running.child.exitCode}` : running.child.signalCode}); see its log lines above`);
      }
      const probe = await probeHttp(entry.healthUrl, { ca, timeoutMs: 2000 });
      if (probe.ok) break;
      lastError = probe.error ?? `HTTP ${probe.status}`;
      if (Date.now() > deadline) throw new CliError(`${running.service} did not become healthy at ${entry.healthUrl} within ${Math.round(timeoutMs / 1000)} s (last result: ${lastError}); see its log lines above`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

/** Mints a new Router token when it is missing or near expiry. Returns true when it changed. */
export function refreshRouterToken(paths: HivePaths, output: Output): boolean {
  const routerFile = paths.envFile("router");
  const memoryFile = paths.envFile("memory");
  if (!existsSync(routerFile) || !existsSync(memoryFile)) return false;
  const router = EnvDocument.load(routerFile);
  const problem = memoryTokenProblem(router, EnvDocument.load(memoryFile));
  if (!problem) return false;
  const token = mintMemoryToken(paths, requireInstalled(paths, "memory"));
  router.set(MEMORY_TOKEN_VAR, token);
  writePrivateFile(routerFile, router.toString());
  output.ok(`Issued a new HiveMem token for the Router (${describeTokenProblem(problem)}); valid until ${new Date((tokenExpiry(token) ?? 0) * 1000).toISOString()}`);
  return true;
}

/**
 * Runs the configured servers in the foreground in dependency order, waits for
 * each health endpoint, and stops them in reverse order on SIGINT/SIGTERM or
 * when one exits unexpectedly. Resolves with the launcher's exit code.
 */
export async function runSupervisor(paths: HivePaths, output: Output, options: StartOptions): Promise<number> {
  const services = sortServices(options.services);
  if (services.length === 0) throw new CliError("no services are configured; run `hive init` first");
  const previous = readPidFile(paths);
  if (previous && previous.pid !== process.pid && processAlive(previous.pid)) {
    throw new CliError(`hive start is already running (pid ${previous.pid}); stop it first, or use \`hive status\``);
  }
  const servers = new Map<ServiceName, InstalledServer>();
  for (const service of services) {
    servers.set(service, requireInstalled(paths, service));
    envFileArgs(paths, service);
  }

  const state = readState(paths);
  for (const service of services) {
    const doc = EnvDocument.load(paths.envFile(service));
    try {
      if (service === "memory" && doc.get("HIVEMEM_TS_PERSISTENCE") !== "memory") await ensureStoreRunning({ output, state }, "qdrant", doc.get("HIVEMEM_QDRANT_URL") ?? "http://127.0.0.1:6333");
      if (service === "iam") await ensureStoreRunning({ output, state }, "redis", doc.get("REDIS_URL") ?? "redis://localhost:6379");
    } catch (error) {
      throw new CliError((error as Error).message);
    }
  }
  if (services.includes("router") && existsSync(paths.envFile("memory"))) {
    try {
      refreshRouterToken(paths, output);
    } catch (error) {
      // The Router still starts; only its Memory pages need the token.
      output.warn(`${(error as Error).message}; the console's Memory pages will not work until it is fixed`);
    }
  }

  const ca = probeCa(paths);
  const running = new Map<ServiceName, Running>();
  let stopping = false;
  let exitCode = 0;
  let resolveDone: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => { resolveDone = resolve; });

  const writePid = () => {
    const children: Partial<Record<ServiceName, number>> = {};
    for (const [service, entry] of running) if (entry.child.pid) children[service] = entry.child.pid;
    writePrivateFile(paths.pidFile, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), services: children } satisfies LauncherPid)}\n`);
  };

  const stopOne = async (entry: Running): Promise<void> => {
    entry.expectedExit = true;
    if (entry.child.exitCode !== null || entry.child.signalCode !== null) return;
    output.step(`stopping ${entry.service}`);
    entry.child.kill("SIGTERM");
    const timer = setTimeout(() => {
      output.warn(`${entry.service} did not stop within ${STOP_TIMEOUT_MS / 1000} s; killing it`);
      entry.child.kill("SIGKILL");
    }, STOP_TIMEOUT_MS);
    await entry.exited;
    clearTimeout(timer);
  };

  const stopAll = async (code: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    clearInterval(tokenTimer);
    for (const service of [...services].reverse()) {
      const entry = running.get(service);
      if (entry) await stopOne(entry);
    }
    rmSync(paths.pidFile, { force: true });
    resolveDone(exitCode);
  };

  const launch = (service: ServiceName): Running => {
    const server = servers.get(service) as InstalledServer;
    // A separate process group: a terminal Ctrl-C reaches only the launcher,
    // which then stops the servers one by one in reverse dependency order.
    const child = spawn(process.execPath, [server.binPath, "start", ...envFileArgs(paths, service)], {
      cwd: paths.home,
      env: serverEnvironment(paths),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    child.stdout?.on("data", prefixer(service, output, process.stdout));
    child.stderr?.on("data", prefixer(service, output, process.stderr));
    const entry: Running = {
      service,
      child,
      expectedExit: false,
      exited: new Promise((resolve) => {
        child.once("error", (error) => {
          output.error(`${service}: cannot start ${server.binPath}: ${error.message}`);
          resolve(null);
        });
        child.once("exit", (code, signal) => {
          resolve(code);
          if (!entry.expectedExit && !stopping) {
            output.error(`${service} exited unexpectedly (${code !== null ? `exit code ${code}` : `signal ${signal}`}); stopping the other services`);
            void stopAll(1);
          }
        });
      }),
    };
    running.set(service, entry);
    writePid();
    return entry;
  };

  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping) {
      output.warn(`${signal} again: killing the servers now`);
      for (const entry of running.values()) entry.child.kill("SIGKILL");
      return;
    }
    output.info("");
    output.step(`${signal} received; stopping in reverse order (press Ctrl-C again to force)`);
    void stopAll(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  // Last resort if the launcher dies abruptly: do not leave orphaned servers behind.
  const killChildren = () => { for (const entry of running.values()) if (entry.child.exitCode === null) entry.child.kill("SIGTERM"); };
  process.on("exit", killChildren);

  const restartRouter = async (): Promise<void> => {
    const entry = running.get("router");
    if (!entry || stopping) return;
    output.step("restarting router so it uses the new HiveMem token");
    await stopOne(entry);
    if (stopping) return;
    const next = launch("router");
    await waitHealthy(listeners("router", EnvDocument.load(paths.envFile("router"))), ca, STARTUP_TIMEOUT_MS.router, next);
    output.ok("router is healthy again");
  };
  const tokenTimer = setInterval(() => {
    if (stopping || !running.has("router")) return;
    try {
      if (refreshRouterToken(paths, output)) void restartRouter().catch((error: unknown) => {
        output.error(`router restart failed: ${(error as Error).message}`);
        void stopAll(1);
      });
    } catch (error) {
      output.warn(`could not renew the Router's HiveMem token: ${(error as Error).message}`);
    }
  }, TOKEN_CHECK_INTERVAL_MS);
  tokenTimer.unref();

  try {
    for (const service of services) {
      if (stopping) break;
      output.step(`starting ${service} (${SERVICES[service].packageName} ${servers.get(service)?.version})`);
      const entry = launch(service);
      const doc = EnvDocument.load(paths.envFile(service));
      const timeoutMs = options.timeoutSeconds !== undefined ? options.timeoutSeconds * 1000 : STARTUP_TIMEOUT_MS[service];
      await waitHealthy(listeners(service, doc), ca, timeoutMs, entry);
      if (!stopping) output.ok(`${service} is healthy (${listeners(service, doc).map((item) => item.url).join(", ")})`);
    }
  } catch (error) {
    if (!stopping) {
      output.error(error instanceof Error ? error.message : String(error));
      await stopAll(1);
    }
  }
  if (!stopping) {
    const routerDoc = services.includes("router") ? EnvDocument.load(paths.envFile("router")) : null;
    output.heading("Hive is running");
    if (routerDoc) output.info(`  Console  ${(routerDoc.get("PUBLIC_ADMIN_URL") ?? listeners("router", routerDoc).find((item) => item.plane === "admin")?.url ?? "").replace(/\/?$/u, "/")}`);
    output.info("  Press Ctrl-C to stop all services.");
  }
  const code = await done;
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  process.off("SIGHUP", onSignal);
  process.off("exit", killChildren);
  return code;
}
