import { existsSync, readFileSync } from "node:fs";
import { writePrivateFile } from "./envfile.js";
import type { HivePaths } from "./paths.js";

export type StoreName = "qdrant" | "redis";

/** A Docker container `hive init` started, so `hive start` can restart it. */
export interface ManagedContainer {
  name: string;
  image: string;
  hostPort: number;
  volume?: string;
}

export interface LauncherState {
  version: 1;
  containers: Partial<Record<StoreName, ManagedContainer>>;
}

export function readState(paths: HivePaths): LauncherState {
  if (!existsSync(paths.state)) return { version: 1, containers: {} };
  try {
    const parsed = JSON.parse(readFileSync(paths.state, "utf8")) as Partial<LauncherState>;
    return { version: 1, containers: parsed.containers ?? {} };
  } catch {
    return { version: 1, containers: {} };
  }
}

export function writeState(paths: HivePaths, state: LauncherState): void {
  writePrivateFile(paths.state, `${JSON.stringify(state, null, 2)}\n`);
}
