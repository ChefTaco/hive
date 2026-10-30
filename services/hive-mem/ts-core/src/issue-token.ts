import { HIVEMEM_JWT_AUDIENCE, HIVEMEM_JWT_ISSUER, isUsableSigningSecret, signToken, verifyBearerToken } from "./auth.js";
import type { JsonObject } from "./types.js";

/**
 * `hivemem-server issue-token`: mint an HS256 access token locally with
 * HIVEMEM_JWT_SECRET, for operators and launchers that need a server-side
 * credential (for example the Hive Router's memory proxy token) without an
 * existing admin token to call `POST /v1/auth/tokens`.
 */

/** Scopes an agent token gets when none are requested; the same set `POST /v1/agents/register` grants. */
export const DEFAULT_AGENT_SCOPES: readonly string[] = ["memories:read", "memories:write", "sessions:read", "sessions:write", "context:read", "agents:read", "agents:write", "workspaces:read", "workspaces:write", "webhooks:read", "webhooks:write", "queue:read"];
export const ADMIN_SCOPE = "admin:all";
export const TOKEN_ROLES = ["admin", "agent"] as const;
export type TokenRole = (typeof TOKEN_ROLES)[number];

export const ISSUE_TOKEN_MIN_TTL_SECONDS = 60;
/** Same ceiling as the 720-hour cap of `POST /v1/auth/tokens`. */
export const ISSUE_TOKEN_MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
export const ISSUE_TOKEN_DEFAULT_TTL_SECONDS = ISSUE_TOKEN_MAX_TTL_SECONDS;

const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const SCOPE_PATTERN = /^(\*|[A-Za-z0-9_-]+(:[A-Za-z0-9_*-]+)+)$/u;
const DURATION_PATTERN = /^(\d+)([smhd]?)$/u;
const UNIT_SECONDS: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86_400 };

export interface IssueTokenRequest {
  subject: string;
  role: TokenRole;
  /** Empty means the role's default scopes. */
  scopes: readonly string[];
  ttlSeconds: number;
}

export interface IssuedToken {
  token: string;
  claims: JsonObject;
  expiresAt: Date;
}

/** Parses `3600`, `90s`, `45m`, `12h` or `30d` into seconds; returns NaN when malformed. */
export function parseDuration(text: string): number {
  const match = DURATION_PATTERN.exec(text.trim());
  if (!match) return Number.NaN;
  return Number.parseInt(match[1] ?? "", 10) * (UNIT_SECONDS[match[2] ?? ""] ?? Number.NaN);
}

/** Splits `--scope` values given as repeated flags, spaces, or commas. */
export function splitScopes(values: readonly string[]): string[] {
  return [...new Set(values.flatMap((value) => value.split(/[\s,]+/u)).filter(Boolean))];
}

export function signingSecretProblem(secret: string | undefined): string | null {
  if (secret === undefined || secret === "") return "HIVEMEM_JWT_SECRET is not set; set it in the environment or pass the server's --env-file.";
  if (!isUsableSigningSecret(secret)) return "HIVEMEM_JWT_SECRET must be at least 32 bytes and not a placeholder; use the same value the server runs with.";
  return null;
}

/** Validates a request and fills in default scopes. Returns one line per problem. */
export function resolveIssueTokenRequest(input: { subject?: string; role?: string; scopes?: readonly string[]; ttl?: string }): { request: IssueTokenRequest | null; problems: string[] } {
  const problems: string[] = [];
  const subject = input.subject?.trim() ?? "";
  if (!subject) problems.push("--subject is required: the agent or service identity the token is for (for example --subject hive-router).");
  else if (!SUBJECT_PATTERN.test(subject)) problems.push("--subject must be 1-128 characters of letters, digits, '.', '_', ':', '@' or '-', starting with a letter or digit.");

  const role = input.role ?? "agent";
  if (!(TOKEN_ROLES as readonly string[]).includes(role)) problems.push(`--role must be admin or agent (got "${role}").`);

  const requested = splitScopes(input.scopes ?? []);
  const invalid = requested.filter((scope) => !SCOPE_PATTERN.test(scope));
  if (invalid.length > 0) problems.push(`--scope values must look like memories:read (got ${invalid.map((scope) => `"${scope}"`).join(", ")}).`);
  if (role === "agent" && requested.some((scope) => scope === "*" || scope.startsWith("admin:"))) {
    problems.push("agent tokens cannot carry wildcard or admin:* scopes; use --role admin for an administrator token.");
  }

  let ttlSeconds = ISSUE_TOKEN_DEFAULT_TTL_SECONDS;
  if (input.ttl !== undefined) {
    ttlSeconds = parseDuration(input.ttl);
    if (!Number.isFinite(ttlSeconds)) problems.push(`--ttl must be a duration such as 3600, 90m, 12h or 30d (got "${input.ttl}").`);
    else if (ttlSeconds < ISSUE_TOKEN_MIN_TTL_SECONDS || ttlSeconds > ISSUE_TOKEN_MAX_TTL_SECONDS) {
      problems.push(`--ttl must be between ${ISSUE_TOKEN_MIN_TTL_SECONDS} seconds and 30 days (got "${input.ttl}"); issue a new token before it expires.`);
    }
  }

  if (problems.length > 0) return { request: null, problems };
  const scopes = requested.length > 0 ? requested : role === "admin" ? [ADMIN_SCOPE] : [...DEFAULT_AGENT_SCOPES];
  return { request: { subject, role: role as TokenRole, scopes, ttlSeconds }, problems };
}

/**
 * Signs the token with the same claim set the server issues and accepts
 * (iss, aud, token_type, jti, iat added by signToken), then verifies it with the
 * server's own verifier so a token this command prints is one the server takes.
 */
export function issueToken(secret: string, request: IssueTokenRequest, now: number = Date.now()): IssuedToken {
  const problem = signingSecretProblem(secret);
  if (problem) throw new Error(problem);
  const iat = Math.floor(now / 1000);
  const exp = iat + request.ttlSeconds;
  const token = signToken(secret, { sub: request.subject, role: request.role, scope: request.scopes.join(" "), iat, exp });
  const principal = verifyBearerToken(`Bearer ${token}`, secret, { issuer: HIVEMEM_JWT_ISSUER, audience: HIVEMEM_JWT_AUDIENCE });
  return { token, claims: principal.rawClaims, expiresAt: new Date(exp * 1000) };
}
