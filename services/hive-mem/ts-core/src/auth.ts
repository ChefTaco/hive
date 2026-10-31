import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { AuthPrincipal, JsonObject, JsonValue } from "./types.js";
import { isJsonObject } from "./validation.js";

export class AuthError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

export const HIVEMEM_JWT_ISSUER = "hivemem";
export const HIVEMEM_JWT_AUDIENCE = "hivemem-api";

/** A signing secret must be at least 32 bytes and must not look like a placeholder value. */
export function isUsableSigningSecret(secret: string | undefined): secret is string {
  return Boolean(secret) && Buffer.byteLength(secret ?? "") >= 32 && !/change[_-]?me|placeholder|example|development/i.test(secret ?? "");
}

export interface VerifyTokenOptions {
  issuer?: string;
  audience?: string;
  isRevoked?: (jti: string) => boolean;
  /** Opt-in maximum token lifetime (seconds). Unset means no cap, matching the
   *  legacy HiveMem behavior that accepted long-lived agent tokens. */
  maxLifetimeSeconds?: number;
  tokenType?: string;
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function parseClaims(payload: Buffer): JsonObject {
  const parsed = parseJwtJson(payload);
  if (!isJsonObject(parsed)) throw new AuthError(401, "JWT payload must be an object");
  return parsed;
}

function parseJwtJson(value: Buffer): unknown {
  try {
    return JSON.parse(value.toString("utf8")) as unknown;
  } catch {
    // Parser errors may include fragments of the supplied token.
    throw new AuthError(401, "Invalid JWT JSON");
  }
}

function normalizeScopes(value: JsonValue | undefined): readonly string[] {
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  return [];
}

export function verifyBearerToken(header: string | undefined, secret: string, options: VerifyTokenOptions = {}): AuthPrincipal {
  if (!header?.startsWith("Bearer ")) throw new AuthError(401, "Missing bearer token");
  const token = header.slice("Bearer ".length).trim();
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError(401, "Invalid JWT format");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSignature) throw new AuthError(401, "Invalid JWT format");

  const jwtHeader = parseJwtJson(base64UrlDecode(encodedHeader));
  if (!isJsonObject(jwtHeader) || jwtHeader.alg !== "HS256") throw new AuthError(401, "Unsupported JWT algorithm");

  const expected = createHmac("sha256", secret).update(`${encodedHeader}.${encodedPayload}`).digest();
  const actual = base64UrlDecode(encodedSignature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new AuthError(401, "Invalid JWT signature");
  }

  const claims = parseClaims(base64UrlDecode(encodedPayload));
  const now = Math.floor(Date.now() / 1000);
  // Backward compatibility: the legacy HiveMem (Python) service authenticated
  // agent tokens by verifying only the HS256 signature, `exp`, and `sub`. Its
  // long-lived agent tokens (e.g. 1-year lifetime, no `iss`/`aud`/`jti`) are
  // still deployed on Hermes hosts, so the TypeScript core must keep accepting
  // them. Optional claims are validated only when present, and the stricter
  // issuer/audience/lifetime policy is opt-in via `options`.
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) throw new AuthError(401, "JWT exp claim is required");
  if (claims.exp <= now) {
    throw new AuthError(401, "JWT has expired");
  }
  for (const name of ["iat", "nbf"] as const) {
    if (claims[name] !== undefined && (typeof claims[name] !== "number" || !Number.isFinite(claims[name]))) throw new AuthError(401, `Invalid JWT ${name} claim`);
  }
  if (typeof claims.iat === "number" && claims.iat >= claims.exp) throw new AuthError(401, "Invalid JWT iat claim");
  // `iat` is optional; when present it must not be in the future (allow skew).
  if (typeof claims.iat === "number" && Number.isFinite(claims.iat) && claims.iat > now + 60) throw new AuthError(401, "Invalid JWT iat claim");
  // Maximum-lifetime enforcement is opt-in (no default cap) so long-lived
  // legacy agent tokens keep working. Revocation remains the primary control.
  if (typeof options.maxLifetimeSeconds === "number") {
    if (!Number.isFinite(options.maxLifetimeSeconds) || options.maxLifetimeSeconds <= 0) throw new Error("maxLifetimeSeconds must be positive and finite");
    if (typeof claims.iat !== "number" || claims.exp - claims.iat > options.maxLifetimeSeconds) throw new AuthError(401, "JWT lifetime exceeds policy");
  }
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) throw new AuthError(401, "JWT is not active yet");
  // `iss`/`aud` are validated only when the token carries them (legacy agent
  // tokens omit both). A present-but-mismatched claim is still rejected.
  const expectedIssuer = options.issuer ?? HIVEMEM_JWT_ISSUER;
  if (claims.iss !== undefined && claims.iss !== expectedIssuer) throw new AuthError(401, "Invalid JWT issuer");
  const expectedAudience = options.audience ?? HIVEMEM_JWT_AUDIENCE;
  const audiences = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) && claims.aud.every((item) => typeof item === "string") ? claims.aud : [];
  if (claims.aud !== undefined && !audiences.includes(expectedAudience)) throw new AuthError(401, "Invalid JWT audience");
  // `token_type`, when present, must be an access token (legacy tokens defaulted
  // to "access" when the claim was absent).
  if (claims.token_type !== undefined && claims.token_type !== (options.tokenType ?? "access")) throw new AuthError(401, "Invalid JWT token type");
  // `jti` is optional; when present it enables revocation.
  if (claims.jti !== undefined && (typeof claims.jti !== "string" || !claims.jti.trim())) throw new AuthError(401, "Invalid JWT jti claim");
  const jti = typeof claims.jti === "string" ? claims.jti : undefined;
  if (jti && options.isRevoked?.(jti)) throw new AuthError(401, "JWT has been revoked");
  const parentJtis = parentTokenIds(claims);
  if (options.isRevoked && parentJtis.some((parent) => options.isRevoked?.(parent))) throw new AuthError(401, "JWT has been revoked");
  const agentId = typeof claims.sub === "string" && claims.sub.trim().length > 0 ? claims.sub : undefined;
  if (!agentId) throw new AuthError(401, "JWT sub claim is required");
  return {
    agentId,
    scopes: normalizeScopes(claims.scope ?? claims.scopes),
    rawClaims: claims,
  };
}

export const MAX_TOKEN_LINEAGE = 16;

/** Returns the `jti` values of the tokens this token was refreshed from. */
export function parentTokenIds(claims: JsonObject): string[] {
  const value = claims.parent_jtis;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TOKEN_LINEAGE || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new AuthError(401, "Invalid JWT parent_jtis claim");
  }
  return value as string[];
}

export function signToken(secret: string, claims: JsonObject): string {
  const now = Math.floor(Date.now() / 1000);
  const completeClaims: JsonObject = {
    iss: HIVEMEM_JWT_ISSUER,
    aud: HIVEMEM_JWT_AUDIENCE,
    token_type: "access",
    iat: now,
    jti: randomUUID(),
    ...claims,
  };
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify(completeClaims));
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

