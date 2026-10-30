import { createHmac, timingSafeEqual } from "node:crypto";
import { CliError } from "./errors.js";
import type { EnvDocument } from "./envfile.js";
import type { HivePaths } from "./paths.js";
import { envFileArgs, runServerCommand, type InstalledServer } from "./runtime.js";

export const MEMORY_TOKEN_VAR = "HIVE_ROUTER_MEMORY_PROXY_TOKEN";
/** The Router authenticates to HiveMem as this admin identity, as the production deploy does. */
export const MEMORY_TOKEN_ARGS = ["--subject", "hive-router", "--role", "admin", "--ttl", "30d"];
/** Re-issue the token when it has less than this left. */
export const REFRESH_BEFORE_SECONDS = 7 * 24 * 60 * 60;

export function tokenClaims(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return typeof claims === "object" && claims !== null && !Array.isArray(claims) ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function tokenExpiry(token: string): number | null {
  const exp = tokenClaims(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
}

/** Checks the HS256 signature locally, to notice a rotated HIVEMEM_JWT_SECRET. */
export function signedWith(token: string, secret: string): boolean {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return false;
  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
  const actual = Buffer.from(signature, "base64url");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export type TokenProblem = "missing" | "malformed" | "wrong-secret" | "expired" | "expiring";

/** Why the Router's HiveMem token must be re-issued, or null when it is good. */
export function memoryTokenProblem(routerEnv: EnvDocument, memoryEnv: EnvDocument, nowSeconds = Math.floor(Date.now() / 1000)): TokenProblem | null {
  const token = routerEnv.get(MEMORY_TOKEN_VAR);
  if (!token) return "missing";
  const exp = tokenExpiry(token);
  if (exp === null) return "malformed";
  const secret = memoryEnv.get("HIVEMEM_JWT_SECRET");
  if (secret && !signedWith(token, secret)) return "wrong-secret";
  if (exp <= nowSeconds) return "expired";
  if (exp - nowSeconds < REFRESH_BEFORE_SECONDS) return "expiring";
  return null;
}

export function describeTokenProblem(problem: TokenProblem): string {
  return {
    missing: "no HiveMem token yet",
    malformed: "the HiveMem token is not a JWT",
    "wrong-secret": "the HiveMem token was signed with a different HIVEMEM_JWT_SECRET",
    expired: "the HiveMem token has expired",
    expiring: "the HiveMem token expires within 7 days",
  }[problem];
}

/** Mints the Router's admin token with the installed `hivemem-server issue-token`. */
export function mintMemoryToken(paths: HivePaths, memory: InstalledServer): string {
  const result = runServerCommand(paths, memory, ["issue-token", ...envFileArgs(paths, "memory"), ...MEMORY_TOKEN_ARGS]);
  const token = result.stdout.trim();
  if (result.status !== 0 || !/^[\w-]+\.[\w-]+\.[\w-]+$/u.test(token)) {
    const reason = result.stderr.trim().split("\n")[0] || `exit code ${result.status}`;
    throw new CliError(`cannot mint the Router's HiveMem token with hivemem-server issue-token: ${reason}`);
  }
  return token;
}
