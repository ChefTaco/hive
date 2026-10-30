#!/usr/bin/env node
import { resolve } from "node:path";
import { parseFlags, type FlagKind, type ParsedFlags } from "./args.js";
import { printDoctor, runDoctor } from "./doctor.js";
import { CliError, UsageError } from "./errors.js";
import { PORT_KEYS, runInit, type InitOptions, type PortKey } from "./init.js";
import { createOutput } from "./output.js";
import { hivePaths } from "./paths.js";
import { createPrompter } from "./prompt.js";
import { installServers } from "./runtime.js";
import { parseServiceList, SERVICE_NAMES, type ServiceName } from "./services.js";
import { collectStatus, configuredServices, printStatus } from "./status.js";
import { runSupervisor } from "./supervisor.js";
import { launcherVersion, PACKAGE_NAME, serverRange } from "./version.js";

const COMMON: Record<string, FlagKind> = { "--help": "boolean" };

const HELP: Record<string, string> = {
  main: `Usage: hive <command> [options]

Hive launcher (${PACKAGE_NAME}): installs, configures and runs the Hive servers.

Commands:
  init      Choose services, install the servers, and write their configuration
  start     Run the configured servers in the foreground (Ctrl-C stops them)
  status    Show the health of each configured service
  doctor    Check this machine and each server's configuration
  install   Install or upgrade the server packages

Options:
  -h, --help      Show help (also: hive <command> --help)
  -v, --version   Print the version

Everything lives in $HIVE_HOME (default ~/.hive). Start with: hive init`,
  init: `Usage: hive init [options]

Sets up Hive in $HIVE_HOME: installs the server packages (after asking), writes
config/<service>.env with generated secrets and the wiring between services,
creates a local CA and TLS certificate, and finds or starts Qdrant and Redis.
Running it again is safe: existing settings and secrets are kept, and changes
to existing files are shown and confirmed first.

Options:
  --services <list>       memory,router,iam (default: all three, or ask)
  --hostname <name>       Also serve the console under this name (adds it to the
                          certificate and listens on all interfaces)
  --no-tls                Plain HTTP on 127.0.0.1 (no openssl needed)
  --port <name>=<port>    Use a specific port; names: ${PORT_KEYS.join(", ")} (repeatable)
  --qdrant-url <url>      Use this Qdrant instead of finding or starting one
  --redis-url <url>       Use this Redis instead of finding or starting one
  --docker-prefix <name>  Name prefix of Docker containers and volumes (default: hive)
  --from <dir>            Install the servers from npm-pack tarballs in <dir>
                          (also HIVE_INSTALL_FROM) instead of the npm registry
  -y, --yes               Take the default answer to every question`,
  start: `Usage: hive start [service...] [options]

Runs the configured servers (default: all) in the foreground in dependency
order (iam, memory, router). Each must pass its health check before the next
starts. Log lines are prefixed with the service name. Ctrl-C or SIGTERM stops
them in reverse order. If one exits unexpectedly, the others are stopped and
hive exits with code 1. The Router's HiveMem token is renewed when it is
missing or expires within 7 days, also while running (the Router restarts).

Options:
  --timeout <seconds>  Health-check timeout per service (default: 180 for iam, 90 otherwise)`,
  status: `Usage: hive status [--json]

Shows the health of each configured service and its store (Qdrant, Redis),
whether or not \`hive start\` runs in another terminal. Exits 1 when a
configured service is down.`,
  doctor: `Usage: hive doctor [--json]

Checks Node.js, npm, openssl, Docker, flock, pamtester and ports, then runs each
installed server's \`check\` command with its env file and summarizes the
results. Exits 1 when something needs fixing.`,
  install: `Usage: hive install [service...] [options]

Installs or upgrades the server packages into $HIVE_HOME/runtime with
\`npm install --prefix\`, pinned to this launcher's major version (${serverRange()}).
Without services, installs the configured ones (or all three).
Restart \`hive start\` afterwards to run the new versions.

Options:
  --from <dir>  Install from npm-pack tarballs in <dir> (also HIVE_INSTALL_FROM)
  -y, --yes     Install without asking`,
};

function servicesFrom(flags: ParsedFlags): ServiceName[] {
  try {
    return parseServiceList(flags.positionals);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

function fromDirectory(flags: ParsedFlags): string | undefined {
  const value = flags.strings.get("--from") ?? process.env.HIVE_INSTALL_FROM;
  return value ? resolve(value) : undefined;
}

function parsePorts(values: readonly string[]): Partial<Record<PortKey, number>> {
  const ports: Partial<Record<PortKey, number>> = {};
  for (const value of values) {
    const match = /^([a-z-]+)=(\d{1,5})$/u.exec(value);
    const key = match?.[1] as PortKey | undefined;
    const port = Number(match?.[2]);
    if (!match || !key || !(PORT_KEYS as readonly string[]).includes(key)) throw new UsageError(`--port takes <name>=<port> with a name from ${PORT_KEYS.join(", ")} (got "${value}")`);
    if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new UsageError(`--port ${key} must be between 1024 and 65535`);
    ports[key] = port;
  }
  return ports;
}

async function main(argv: readonly string[]): Promise<number> {
  const output = createOutput();
  const [first, ...rest] = argv;
  if (first === undefined || first === "--help" || first === "-h") {
    output.info(HELP.main);
    return 0;
  }
  if (first === "--version" || first === "-v") {
    output.info(launcherVersion());
    return 0;
  }
  if (first === "help") {
    const topic = rest[0] ?? "main";
    output.info(HELP[topic] ?? HELP.main);
    return 0;
  }
  if (!(first in HELP) || first === "main") throw new UsageError(`unknown command ${first}; run \`hive --help\``);
  const command = first;
  const paths = hivePaths();

  switch (command) {
    case "init": {
      const flags = parseFlags(rest, { ...COMMON, "--yes": "boolean", "--services": "string", "--hostname": "string", "--no-tls": "boolean", "--port": "repeat", "--qdrant-url": "string", "--redis-url": "string", "--docker-prefix": "string", "--from": "string" }, command);
      if (flags.booleans.has("--help")) return printHelp(command);
      if (flags.positionals.length > 0) throw new UsageError(`unexpected argument ${flags.positionals[0]}; use --services ${flags.positionals.join(",")}`);
      let services: ServiceName[] | undefined;
      const servicesFlag = flags.strings.get("--services");
      if (servicesFlag !== undefined) {
        try {
          services = parseServiceList([servicesFlag]);
        } catch (error) {
          throw new UsageError((error as Error).message);
        }
      }
      const options: InitOptions = {
        services,
        hostname: flags.strings.get("--hostname")?.toLowerCase(),
        tls: !flags.booleans.has("--no-tls"),
        from: fromDirectory(flags),
        ports: parsePorts(flags.repeats.get("--port") ?? []),
        qdrantUrl: urlOption(flags, "--qdrant-url", ["http:", "https:"]),
        redisUrl: urlOption(flags, "--redis-url", ["redis:", "rediss:"]),
        dockerPrefix: flags.strings.get("--docker-prefix") ?? "hive",
      };
      const prompter = createPrompter({ yes: flags.booleans.has("--yes"), output });
      try {
        await runInit({ paths, output, prompter, options });
      } finally {
        prompter.close();
      }
      return 0;
    }
    case "install": {
      const flags = parseFlags(rest, { ...COMMON, "--yes": "boolean", "--from": "string" }, command);
      if (flags.booleans.has("--help")) return printHelp(command);
      const chosen = servicesFrom(flags);
      const configured = configuredServices(paths);
      const services = chosen.length > 0 ? chosen : configured.length > 0 ? configured : [...SERVICE_NAMES];
      const prompter = createPrompter({ yes: flags.booleans.has("--yes"), output });
      try {
        const done = await installServers(paths, services, { from: fromDirectory(flags), prompter, output });
        if (!done) {
          output.info("Nothing was installed.");
          return 1;
        }
      } finally {
        prompter.close();
      }
      output.info("Restart `hive start` to run the new versions.");
      return 0;
    }
    case "start": {
      const flags = parseFlags(rest, { ...COMMON, "--timeout": "string" }, command);
      if (flags.booleans.has("--help")) return printHelp(command);
      const configured = configuredServices(paths);
      const chosen = servicesFrom(flags);
      const missing = chosen.filter((service) => !configured.includes(service));
      if (missing.length > 0) throw new CliError(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not configured; run \`hive init --services ${[...configured, ...missing].join(",")}\``);
      const timeout = flags.strings.get("--timeout");
      if (timeout !== undefined && !/^\d+$/u.test(timeout)) throw new UsageError("--timeout takes a number of seconds");
      return runSupervisor(paths, output, { services: chosen.length > 0 ? chosen : configured, timeoutSeconds: timeout === undefined ? undefined : Number(timeout) });
    }
    case "status": {
      const flags = parseFlags(rest, { ...COMMON, "--json": "boolean" }, command);
      if (flags.booleans.has("--help")) return printHelp(command);
      if (flags.positionals.length > 0) throw new UsageError(`unexpected argument ${flags.positionals[0]}`);
      const report = await collectStatus(paths);
      if (flags.booleans.has("--json")) output.info(JSON.stringify(report, null, 2));
      else printStatus(report, output);
      return report.ok ? 0 : 1;
    }
    case "doctor": {
      const flags = parseFlags(rest, { ...COMMON, "--json": "boolean" }, command);
      if (flags.booleans.has("--help")) return printHelp(command);
      if (flags.positionals.length > 0) throw new UsageError(`unexpected argument ${flags.positionals[0]}`);
      const checks = await runDoctor(paths);
      if (flags.booleans.has("--json")) {
        output.info(JSON.stringify({ home: paths.home, ok: checks.every((check) => check.level !== "fail"), checks }, null, 2));
        return checks.some((check) => check.level === "fail") ? 1 : 0;
      }
      output.info(`Hive doctor (${PACKAGE_NAME} ${launcherVersion()}, ${paths.home})`);
      return printDoctor(checks, output);
    }
  }
  throw new UsageError(`unknown command ${command}`);

  function printHelp(name: string): number {
    output.info(HELP[name] ?? HELP.main);
    return 0;
  }
}

function urlOption(flags: ParsedFlags, name: string, protocols: readonly string[]): string | undefined {
  const value = flags.strings.get(name);
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (!protocols.includes(url.protocol)) throw new Error("protocol");
    return value.replace(/\/+$/u, "");
  } catch {
    throw new UsageError(`${name} must be a ${protocols.map((protocol) => `${protocol}//`).join(" or ")} URL (got "${value}")`);
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const output = createOutput();
  if (error instanceof CliError) {
    output.error(`hive: ${error.message}`);
    process.exitCode = error.exitCode;
  } else {
    output.error(`hive: ${error instanceof Error ? error.message : String(error)}`);
    if (process.env.HIVE_DEBUG && error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  }
}
