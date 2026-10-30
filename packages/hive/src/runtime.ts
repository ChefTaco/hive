import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CliError } from "./errors.js";
import { ensurePrivateDir, writePrivateFile } from "./envfile.js";
import type { Output } from "./output.js";
import type { HivePaths } from "./paths.js";
import type { Prompter } from "./prompt.js";
import { SERVICES, type ServiceName } from "./services.js";
import { compareVersions, launcherMajor, majorOf, serverRange } from "./version.js";

export interface InstalledServer {
  service: ServiceName;
  version: string;
  /** Absolute path of the server's bin script; run it with this Node. */
  binPath: string;
}

interface PackageManifest {
  name?: string;
  version?: string;
  bin?: string | Record<string, string>;
}

export function installedServer(paths: HivePaths, service: ServiceName): InstalledServer | null {
  const definition = SERVICES[service];
  const root = join(paths.runtime, "node_modules", ...definition.packageName.split("/"));
  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageManifest;
  } catch {
    return null;
  }
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[definition.bin];
  if (!bin || !manifest.version) return null;
  const binPath = resolve(root, bin);
  return existsSync(binPath) ? { service, version: manifest.version, binPath } : null;
}

export function requireInstalled(paths: HivePaths, service: ServiceName): InstalledServer {
  const installed = installedServer(paths, service);
  if (!installed) throw new CliError(`${SERVICES[service].packageName} is not installed in ${paths.runtime}; run \`hive install ${service}\``);
  return installed;
}

/**
 * Variables passed from the launcher's environment to the servers. Everything
 * else comes from the service's env file, so a stray PORT, NODE_ENV or
 * DATABASE_URL in the shell cannot change a server's configuration.
 */
const PASSED_THROUGH = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TERM", "NO_COLOR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_USE_ENV_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "HIVE_DEBUG", "HIVEMEM_DEBUG"];

export function serverEnvironment(paths: HivePaths, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && (PASSED_THROUGH.includes(name) || name.startsWith("LC_"))) env[name] = value;
  }
  env.HIVE_HOME = paths.home;
  return env;
}

/**
 * Arguments that load a service's env file. Node itself scans argv for
 * `--env-file` and exits 9 when the file is missing, so the file must exist.
 */
export function envFileArgs(paths: HivePaths, service: ServiceName): string[] {
  const file = paths.envFile(service);
  if (!existsSync(file)) throw new CliError(`${file} does not exist; run \`hive init\` to configure ${service}`);
  return [`--env-file=${file}`];
}

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs a short server command (env-schema, check, issue-token) and captures its output. */
export function runServerCommand(paths: HivePaths, server: InstalledServer, args: readonly string[], timeoutMs = 60_000): CommandResult {
  const result = spawnSync(process.execPath, [server.binPath, ...args], {
    cwd: paths.home,
    env: serverEnvironment(paths),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new CliError(`cannot run ${SERVICES[server.service].bin}: ${result.error.message}`);
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

/** Runs a server command asynchronously, so several can run at once (doctor). */
export function runServerCommandAsync(paths: HivePaths, server: InstalledServer, args: readonly string[], timeoutMs = 60_000): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [server.binPath, ...args], { cwd: paths.home, env: serverEnvironment(paths), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ status: 1, stdout, stderr: `${stderr}${error.message}\n` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ status: code ?? 1, stdout, stderr });
    });
  });
}

/** `@hivemagnus/hivemem-server` -> `hivemagnus-hivemem-server`, the prefix `npm pack` gives tarballs. */
export function tarballPrefix(packageName: string): string {
  return packageName.replace(/^@/u, "").replace("/", "-");
}

/** Newest tarball in `directory` for the package with the launcher's major version. */
export function findTarball(directory: string, packageName: string, major = launcherMajor()): string | null {
  const prefix = `${tarballPrefix(packageName)}-`;
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    throw new CliError(`cannot read the package directory ${directory} (--from or HIVE_INSTALL_FROM)`);
  }
  const candidates = entries
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".tgz"))
    .map((entry) => ({ entry, version: entry.slice(prefix.length, -".tgz".length) }))
    .filter(({ version }) => /^\d+\.\d+\.\d+/u.test(version) && majorOf(version) === major)
    .sort((left, right) => compareVersions(right.version, left.version));
  const best = candidates[0];
  return best ? resolve(directory, best.entry) : null;
}

export interface InstallPlanEntry {
  service: ServiceName;
  packageName: string;
  /** What npm installs: `name@range`, or a tarball path with --from. */
  spec: string;
  current: string | null;
}

export function installPlan(paths: HivePaths, services: readonly ServiceName[], from: string | undefined): InstallPlanEntry[] {
  return services.map((service) => {
    const packageName = SERVICES[service].packageName;
    let spec = `${packageName}@${serverRange()}`;
    if (from) {
      const tarball = findTarball(from, packageName);
      if (!tarball) throw new CliError(`no ${tarballPrefix(packageName)}-${launcherMajor()}.x.y.tgz in ${from}; build one with \`npm pack\` in that package, or drop --from to install from npm`);
      spec = tarball;
    }
    return { service, packageName, spec, current: installedServer(paths, service)?.version ?? null };
  });
}

/** Every native add-on the servers need, which the runtime manifest allows to run its install script. */
export const NATIVE_MODULES: readonly string[] = [...new Set(Object.values(SERVICES).flatMap((service) => service.nativeModules))].sort();

/** Optional add-ons with a JavaScript fallback; denied explicitly so npm 12 does not warn about them. */
export const DENIED_INSTALL_SCRIPTS: readonly string[] = ["msgpackr-extract"];

/**
 * The runtime folder is an npm project, so npm 12 only runs dependency install scripts
 * listed in its `allowScripts`. Adds the servers' native add-ons, keeping any entries
 * already there (including a deliberate `false`).
 */
export function runtimeManifest(existing: Record<string, unknown> | null): Record<string, unknown> {
  const manifest: Record<string, unknown> = existing ?? { name: "hive-runtime", private: true, description: "Hive server packages installed by @hivemagnus/hive. Manage them with `hive install`." };
  const current = manifest["allowScripts"];
  const allow: Record<string, unknown> = current && typeof current === "object" && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
  for (const name of NATIVE_MODULES) if (!(name in allow)) allow[name] = true;
  for (const name of DENIED_INSTALL_SCRIPTS) if (!(name in allow)) allow[name] = false;
  manifest["allowScripts"] = allow;
  return manifest;
}

export function ensureRuntimeManifest(paths: HivePaths): void {
  ensurePrivateDir(paths.home);
  ensurePrivateDir(paths.runtime);
  const file = join(paths.runtime, "package.json");
  let existing: Record<string, unknown> | null = null;
  if (existsSync(file)) {
    try {
      existing = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      throw new CliError(`${file} is not valid JSON; fix or remove it, then retry`);
    }
  }
  const next = `${JSON.stringify(runtimeManifest(existing), null, 2)}\n`;
  if (existing === null || readFileSync(file, "utf8") !== next) writePrivateFile(file, next);
}

/**
 * Native add-ons of an installed server that fail to load (for example because npm skipped
 * their install script). Each entry is the module name and the first line of its error.
 */
export function nativeModuleProblems(paths: HivePaths, service: ServiceName): Array<{ module: string; error: string }> {
  const modules = SERVICES[service].nativeModules;
  const server = installedServer(paths, service);
  if (!server || modules.length === 0) return [];
  const packageJson = join(paths.runtime, "node_modules", ...SERVICES[service].packageName.split("/"), "package.json");
  const probe = [
    'const { createRequire } = require("node:module");',
    "const load = createRequire(process.argv[1]);",
    "const failures = [];",
    "for (const name of process.argv.slice(2)) {",
    "  try {",
    '    const mod = load(name);',
    '    if (name === "better-sqlite3") new mod(":memory:").close();',
    "  } catch (error) {",
    '    failures.push({ module: name, error: String(error && error.message || error).split("\\n")[0] });',
    "  }",
    "}",
    "process.stdout.write(JSON.stringify(failures));",
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", probe, packageJson, ...modules], { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) return modules.map((module) => ({ module, error: (result.stderr || "the check could not run").trim().split("\n")[0] ?? "" }));
  try {
    return JSON.parse(result.stdout) as Array<{ module: string; error: string }>;
  } catch {
    return modules.map((module) => ({ module, error: "the check produced no result" }));
  }
}

export function nativeModuleFix(paths: HivePaths, modules: readonly string[]): string {
  return `npm did not build ${modules.join(" and ")}. Run \`hive install\` again, or \`npm rebuild ${modules.join(" ")} --prefix ${paths.runtime}\`. On npm 12, ${join(paths.runtime, "package.json")} must list them under "allowScripts"; \`hive install\` adds them.`;
}

export function npmAvailable(): string | null {
  const result = spawnSync("npm", ["--version"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Shows exactly what will be installed and where, asks (default yes), then
 * runs `npm install --prefix $HIVE_HOME/runtime`. Returns false if declined.
 */
export async function installServers(paths: HivePaths, services: readonly ServiceName[], options: { from?: string | undefined; prompter: Prompter; output: Output; reason?: string }): Promise<boolean> {
  if (services.length === 0) return true;
  const plan = installPlan(paths, services, options.from);
  const { output } = options;
  output.heading(options.reason ?? "Install the Hive server packages");
  output.info(`  into ${paths.runtime} (npm install --prefix):`);
  for (const entry of plan) {
    const note = entry.current ? ` (installed: ${entry.current})` : "";
    output.info(`    ${entry.packageName}  ${entry.spec === `${entry.packageName}@${serverRange()}` ? serverRange() : entry.spec}${note}`);
  }
  if (!(await options.prompter.confirm("Install these packages now?", true))) return false;
  const npmVersion = npmAvailable();
  if (!npmVersion) throw new CliError("npm was not found on PATH; it comes with Node.js. Install Node.js 24 or 26 with npm, then retry.");
  ensureRuntimeManifest(paths);
  const args = ["install", "--prefix", paths.runtime, "--no-fund", "--no-audit", "--omit=dev", ...plan.map((entry) => entry.spec)];
  output.step(`npm ${args.join(" ")}`);
  const status = await new Promise<number>((resolvePromise) => {
    const child = spawn("npm", args, { stdio: ["ignore", "inherit", "inherit"], cwd: paths.runtime });
    child.on("error", () => resolvePromise(1));
    child.on("close", (code) => resolvePromise(code ?? 1));
  });
  if (status !== 0) throw new CliError(`npm install failed (exit code ${status}); see the npm output above`);
  for (const entry of plan) {
    const installed = installedServer(paths, entry.service);
    if (!installed) throw new CliError(`${entry.packageName} did not install a ${SERVICES[entry.service].bin} command in ${paths.runtime}`);
    const broken = nativeModuleProblems(paths, entry.service);
    if (broken.length > 0) throw new CliError(`${entry.packageName} installed, but ${broken.map((item) => `${item.module} does not load (${item.error})`).join("; ")}. ${nativeModuleFix(paths, broken.map((item) => item.module))}`);
    output.ok(`${entry.packageName} ${installed.version}`);
  }
  return true;
}
