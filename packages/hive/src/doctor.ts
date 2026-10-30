import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dockerAvailable } from "./docker.js";
import { listeners, usesTls } from "./endpoints.js";
import { EnvDocument } from "./envfile.js";
import { isPortFree } from "./net.js";
import { paint, type Output } from "./output.js";
import type { HivePaths } from "./paths.js";
import { envFileArgs, installedServer, nativeModuleFix, nativeModuleProblems, npmAvailable, runServerCommandAsync, type CommandResult } from "./runtime.js";
import { SERVICES, type ServiceName } from "./services.js";
import { collectStatus, configuredServices } from "./status.js";
import { opensslVersion } from "./tls.js";
import { describeTokenProblem, memoryTokenProblem } from "./token.js";
import { launcherMajor, majorOf, satisfiesCaretRange, supportedNodeRange } from "./version.js";

export type CheckLevel = "ok" | "warn" | "fail" | "info";

export interface DoctorCheck {
  group: string;
  level: CheckLevel;
  message: string;
  details?: string[];
}

function onPath(command: string, args: string[]): string | null {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000 });
  if (result.error) return null;
  return (result.stdout || result.stderr).trim().split("\n")[0] ?? "";
}

/** Reads a server's `check` output into a level and the lines worth showing. */
export function summarizeServerCheck(service: ServiceName, result: CommandResult, running: ReadonlySet<ServiceName>): DoctorCheck {
  const group = "Server checks";
  if (service === "router") {
    try {
      const report = JSON.parse(result.stdout) as { ok: boolean; checks: Array<{ name: string; status: "ok" | "warn" | "fail"; message: string }> };
      // IAM and HiveMem being unreachable is expected while the stack is stopped.
      const failing = report.checks.filter((check) => check.status === "fail");
      const blocking = failing.filter((check) => !((check.name === "iam" || check.name === "memory") && !running.has(check.name)));
      const notes = report.checks.filter((check) => check.status !== "ok").map((check) => `${check.status === "fail" && !blocking.includes(check) ? "note" : check.status}  ${check.name}: ${check.message}`);
      if (blocking.length > 0) return { group, level: "fail", message: `router: ${blocking.length} problem(s) from hive-router check`, details: notes };
      if (failing.length > 0) return { group, level: "warn", message: "router: configuration OK; IAM or HiveMem is not running, so the Router cannot reach it yet", details: notes };
      return { group, level: notes.length > 0 ? "warn" : "ok", message: "router: hive-router check passed", details: notes };
    } catch {
      return { group, level: "fail", message: `router: hive-router check failed (exit code ${result.status})`, details: (result.stderr || result.stdout).trim().split("\n") };
    }
  }
  const lines = result.stdout.split("\n").filter((line) => /^\s+(FAIL|✗|!|warn)\s/u.test(line)).map((line) => line.trim());
  const bin = SERVICES[service].bin;
  if (result.status === 0) return { group, level: lines.length > 0 ? "warn" : "ok", message: `${service}: ${bin} check passed`, details: lines };
  const fallback = (result.stderr || result.stdout).trim().split("\n").filter(Boolean).slice(0, 5);
  return { group, level: "fail", message: `${service}: ${bin} check found problems (exit code ${result.status})`, details: lines.length > 0 ? lines : fallback };
}

export async function runDoctor(paths: HivePaths): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (group: string, level: CheckLevel, message: string, details?: string[]) => checks.push({ group, level, message, ...(details && details.length > 0 ? { details } : {}) });
  const services = configuredServices(paths);
  const docs = new Map(services.map((service) => [service, EnvDocument.load(paths.envFile(service))] as const));

  const launcher = "Launcher";
  const range = supportedNodeRange();
  add(launcher, satisfiesCaretRange(process.versions.node, range) ? "ok" : "fail", `Node.js ${process.version} (supported: ${range})`);
  const npm = npmAvailable();
  add(launcher, npm ? "ok" : "fail", npm ? `npm ${npm}` : "npm is not on PATH; it is needed to install the servers");
  const tlsInUse = [...docs].some(([service, doc]) => usesTls(service, doc));
  const openssl = opensslVersion();
  add(launcher, openssl ? "ok" : tlsInUse ? "warn" : "info", openssl ?? "openssl is not on PATH; `hive init` needs it to create TLS certificates");
  const docker = dockerAvailable();
  add(launcher, docker.ok ? "ok" : "info", docker.ok ? docker.detail : `Docker: ${docker.detail} (optional; used to run Qdrant and Redis)`);
  if (services.includes("memory")) {
    const flock = onPath("flock", ["--version"]);
    add(launcher, flock !== null ? "ok" : "fail", flock !== null ? "flock is available (HiveMem single-writer lock)" : process.platform === "darwin" ? "flock is missing; HiveMem needs it. Install it with `brew install flock`." : "flock is missing; HiveMem needs it. Install util-linux.");
  }
  const router = docs.get("router");
  if (router && (router.get("HIVE_ROUTER_AUTH_MODE") ?? "os") === "os" && !router.get("HIVE_ROUTER_OS_AUTH_COMMAND")) {
    const pamtester = spawnSync("sh", ["-c", "command -v pamtester"], { encoding: "utf8" }).stdout.trim();
    add(launcher, pamtester ? "ok" : "fail", pamtester ? `pamtester ${pamtester} (console OS sign-in)` : "the Router signs in with OS accounts (HIVE_ROUTER_AUTH_MODE=os) but pamtester is not installed (for example: sudo apt install pamtester)");
  }

  const status = await collectStatus(paths);
  const running = new Set<ServiceName>(status.services.filter((service) => service.listeners.every((entry) => entry.healthy)).map((service) => service.service));
  for (const [service, doc] of docs) {
    for (const entry of listeners(service, doc)) {
      const label = service === "router" ? `router ${entry.plane}` : service;
      const healthy = status.services.find((item) => item.service === service)?.listeners.find((item) => item.plane === entry.plane)?.healthy ?? false;
      if (healthy) add("Ports", "ok", `${entry.port} (${label}) is served by the running ${service}`);
      else if (await isPortFree(entry.port)) add("Ports", "ok", `${entry.port} (${label}) is free`);
      else add("Ports", "fail", `${entry.port} (${label}) is in use by another process; change it in ${service}.env`);
    }
  }

  if (services.length === 0) add("Packages", "warn", "no services are configured; run `hive init`");
  for (const service of services) {
    const installed = installedServer(paths, service);
    if (!installed) add("Packages", "fail", `${SERVICES[service].packageName} is not installed; run \`hive install ${service}\``);
    else if (majorOf(installed.version) !== launcherMajor()) add("Packages", "warn", `${SERVICES[service].packageName} ${installed.version} does not match the launcher's major version ${launcherMajor()}; run \`hive install ${service}\``);
    else add("Packages", "ok", `${SERVICES[service].packageName} ${installed.version}`);
    if (installed) {
      const broken = nativeModuleProblems(paths, service);
      if (broken.length > 0) add("Packages", "fail", `${SERVICES[service].packageName}: ${broken.map((item) => item.module).join(", ")} does not load`, [...broken.map((item) => `${item.module}: ${item.error}`), nativeModuleFix(paths, broken.map((item) => item.module))]);
      else if (SERVICES[service].nativeModules.length > 0) add("Packages", "ok", `${SERVICES[service].packageName}: native add-ons load (${SERVICES[service].nativeModules.join(", ")})`);
    }
  }

  for (const service of status.services) {
    if (!service.store) continue;
    add("Stores", service.store.state === "ok" ? "ok" : "fail", service.store.state === "ok" ? `${service.store.name} answers at ${service.store.url}` : `${service.store.name} at ${service.store.url}: ${service.store.state}; \`hive start\` restarts a container \`hive init\` created`);
  }

  if (router && docs.get("memory")) {
    const problem = memoryTokenProblem(router, docs.get("memory") as EnvDocument);
    add("HiveMem token", problem === null ? "ok" : problem === "expiring" || problem === "missing" ? "warn" : "fail", problem === null ? `the Router's HiveMem token is valid until ${status.memoryTokenExpires}` : `${describeTokenProblem(problem)}; \`hive start\` issues a new one`);
  }

  const runnable = services.filter((service) => installedServer(paths, service) && existsSync(paths.envFile(service)));
  const results = await Promise.all(runnable.map(async (service) => {
    const server = installedServer(paths, service);
    if (!server) return null;
    const args = ["check", ...envFileArgs(paths, service), ...(service === "router" ? ["--json"] : [])];
    return [service, await runServerCommandAsync(paths, server, args)] as const;
  }));
  for (const entry of results) if (entry) checks.push(summarizeServerCheck(entry[0], entry[1], running));
  return checks;
}

export function printDoctor(checks: readonly DoctorCheck[], output: Output): number {
  const marks: Record<CheckLevel, string> = {
    ok: paint("ok  ", "green", output.color),
    warn: paint("warn", "yellow", output.color),
    fail: paint("FAIL", "red", output.color),
    info: paint("info", "blue", output.color),
  };
  let group = "";
  for (const check of checks) {
    if (check.group !== group) {
      group = check.group;
      output.heading(group);
    }
    output.info(`  ${marks[check.level]}  ${check.message}`);
    for (const line of check.details ?? []) output.info(`          ${line}`);
  }
  const failures = checks.filter((check) => check.level === "fail").length;
  const warnings = checks.filter((check) => check.level === "warn").length;
  output.info("");
  output.info(failures === 0 ? `No problems found${warnings ? ` (${warnings} warning${warnings === 1 ? "" : "s"})` : ""}.` : `${failures} problem${failures === 1 ? "" : "s"} found${warnings ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}.`);
  return failures === 0 ? 0 : 1;
}
