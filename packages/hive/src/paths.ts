import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ServiceName } from "./services.js";

export interface HivePaths {
  /** `$HIVE_HOME`, default `~/.hive`. */
  home: string;
  /** Env files, one per service, plus the launcher state. */
  config: string;
  /** npm prefix the server packages are installed into. */
  runtime: string;
  /** Local CA and server certificate. */
  tls: string;
  /** The pid file of a running `hive start`. */
  run: string;
  state: string;
  pidFile: string;
  envFile(service: ServiceName): string;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function hiveHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.HIVE_HOME?.trim();
  return resolve(configured ? expandHome(configured) : join(homedir(), ".hive"));
}

export function hivePaths(env: NodeJS.ProcessEnv = process.env): HivePaths {
  const home = hiveHome(env);
  const config = join(home, "config");
  const run = join(home, "run");
  return {
    home,
    config,
    runtime: join(home, "runtime"),
    tls: join(home, "tls"),
    run,
    state: join(config, "launcher.json"),
    pidFile: join(run, "hive.pid"),
    envFile: (service) => join(config, `${service}.env`),
  };
}
