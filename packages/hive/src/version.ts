import { readFileSync } from "node:fs";

export const PACKAGE_NAME = "@hivemagnus/hive";

interface PackageJson {
  name?: string;
  version?: string;
  engines?: { node?: string };
}

let cached: PackageJson | null = null;

function packageJson(): PackageJson {
  if (cached) return cached;
  // dist/src/version.js and src/version.ts both sit two levels below the package root.
  for (const candidate of ["../../package.json", "../package.json"]) {
    try {
      const parsed = JSON.parse(readFileSync(new URL(candidate, import.meta.url), "utf8")) as PackageJson;
      if (parsed.name === PACKAGE_NAME) {
        cached = parsed;
        return parsed;
      }
    } catch {
      // try the next layout
    }
  }
  cached = { name: PACKAGE_NAME, version: "0.0.0" };
  return cached;
}

export function launcherVersion(): string {
  return packageJson().version ?? "0.0.0";
}

export function launcherMajor(): number {
  return Number.parseInt(launcherVersion().split(".")[0] ?? "0", 10);
}

/** The npm range the servers are pinned to: the launcher's own major version. */
export function serverRange(): string {
  return `^${launcherMajor()}.0.0`;
}

export function supportedNodeRange(): string {
  return packageJson().engines?.node ?? "^24.22.1 || ^26.13.0";
}

function parseVersion(text: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Minimal semver check for `^a.b.c || ^x.y.z` ranges (all the engines field uses). */
export function satisfiesCaretRange(version: string, range: string): boolean {
  const actual = parseVersion(version);
  if (!actual) return false;
  return range.split("||").some((part) => {
    const wanted = parseVersion(part.trim().replace(/^\^/u, ""));
    if (!wanted) return false;
    if (actual[0] !== wanted[0]) return false;
    if (actual[1] !== wanted[1]) return actual[1] > wanted[1];
    return actual[2] >= wanted[2];
  });
}

export function majorOf(version: string): number | null {
  const parsed = parseVersion(version);
  return parsed ? parsed[0] : null;
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left) ?? [0, 0, 0];
  const b = parseVersion(right) ?? [0, 0, 0];
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
