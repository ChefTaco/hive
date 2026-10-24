# @hivemem/iam-sdk

RS256 JWT verification and RBAC middleware for Node.js backends. Ships a **Hono v4 middleware** out of the box and a framework-agnostic **`IamVerifier`** class you can use anywhere.

## Features

- **RS256 JWT verification** via [jose](https://github.com/panva/jose) v6
- **Automatic public-key caching** with configurable TTL (default 1 hour)
- **Key rotation retry** — on verify failure the SDK fetches a fresh public key and retries once
- **Concurrent fetch deduplication** — multiple requests during a cache miss share a single network call
- **Hono v4 middleware** — `verify()`, `requirePermission()`, `requireRole()`
- **Framework-agnostic core** — `IamVerifier` works in any Node.js runtime

## Requirements

- Node.js 20 or later
- A running Hive IAM Core instance that exposes its RS256 public key at `/api/v1/auth/public-key`

## Installation

```bash
npm install @hivemem/iam-sdk
```

`hono ^4.0.0` is an optional peer dependency, needed only if you use the Hono middleware:

```bash
npm install hono
```

## Quick Start — Hono Middleware

```typescript
import { Hono } from 'hono'
import { createIamMiddleware } from '@hivemem/iam-sdk/hono'

const iam = createIamMiddleware({
  publicKeyUrl: 'https://iam.example.com/api/v1/auth/public-key',
  issuer: 'iam-core',          // must match the IAM Core JWT issuer (default: "iam-core")
  cacheTtlMs: 3_600_000,       // public key cache TTL in ms (default: 1 hour)
})

const app = new Hono()

// Apply JWT verification to all routes
app.use('*', iam.verify())

// Require specific permissions on a route
app.get('/users', iam.requirePermission('iam:users:read'), (c) => {
  const principal = c.get('iamPrincipal')
  return c.json({ caller: principal.sub, email: principal.email })
})

// Require any of the listed roles on a route
app.delete('/users/:id', iam.requireRole('ADMIN', 'SUPER_ADMIN'), (c) => {
  return c.json({ deleted: c.req.param('id') })
})

export default app
```

### Custom Unauthorized Response

```typescript
const iam = createIamMiddleware({
  publicKeyUrl: 'https://iam.example.com/api/v1/auth/public-key',
  onUnauthorized: (reason) =>
    new Response(JSON.stringify({ ok: false, reason }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    }),
})
```

## Framework-Agnostic Usage — `IamVerifier`

Use `IamVerifier` directly when you are not on Hono (Express, Fastify, plain Node.js, etc.):

```typescript
import { IamVerifier } from '@hivemem/iam-sdk'

const verifier = new IamVerifier({
  publicKeyUrl: 'https://iam.example.com/api/v1/auth/public-key',
  issuer: 'iam-core',
  audience: 'my-service',
  cacheTtlMs: 3_600_000,
})

// In any request handler:
async function handleRequest(req: Request): Promise<Response> {
  const auth = req.headers.get('authorization')
  if (!auth?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }

  try {
    const principal = await verifier.verify(auth.slice(7))

    // Check permissions
    if (!verifier.hasPermission(principal, 'iam:users:read')) {
      return new Response('Forbidden', { status: 403 })
    }

    // Check roles (returns true if principal has ANY of the listed roles)
    if (!verifier.hasRole(principal, 'ADMIN')) {
      return new Response('Forbidden', { status: 403 })
    }

    return new Response(JSON.stringify({ user: principal.sub }))
  } catch (err) {
    return new Response('Invalid token', { status: 401 })
  }
}
```

## API Reference

### Types

#### `Principal`

The verified identity extracted from a JWT. All middleware and verifier methods return this.

```typescript
type ActorType = 'USER' | 'SERVICE_ACCOUNT' | 'SYSTEM' | 'AGENT'

interface Principal {
  readonly sub: string                    // Subject ID (user, service account, etc.)
  readonly actorType: ActorType           // Type of actor
  readonly email: string | undefined      // Email (if present in token)
  readonly username: string | undefined   // Username (if present in token)
  readonly roles: readonly string[]       // Assigned roles (e.g., ["ADMIN", "VIEWER"])
  readonly permissions: readonly string[] // Granted permissions (e.g., ["iam:users:read"])
  readonly sessionId: string | undefined  // Session ID (if present)
  readonly clientId: string | undefined   // OAuth client ID (if present)
}
```

#### `IamMiddlewareOptions`

Configuration shared by both `IamVerifier` and the Hono middleware.

| Property       | Type     | Default       | Description                              |
| -------------- | -------- | ------------- | ---------------------------------------- |
| `publicKeyUrl` | `string` | **(required)** | Full URL to the IAM Core public key endpoint |
| `issuer`       | `string` | `"iam-core"`  | Expected `iss` claim in JWTs              |
| `audience`     | `string \| string[]` | — | Expected `aud` claim; required by policy for machine consumers |
| `cacheTtlMs`   | `number` | `3600000`     | How long to cache the public key (ms)     |

#### `IamHonoOptions`

Extends `IamMiddlewareOptions` with:

| Property         | Type                          | Default | Description                              |
| ---------------- | ----------------------------- | ------- | ---------------------------------------- |
| `onUnauthorized` | `(reason: string) => Response` | —       | Custom response for 401 errors            |

### `IamVerifier`

| Method | Signature | Description |
| ------ | --------- | ----------- |
| `verify(token)` | `(token: string) => Promise<Principal>` | Verifies a JWT string, returns the decoded `Principal`. Retries once with a fresh key on failure. |
| `hasPermission(principal, ...perms)` | `(p: Principal, ...perms: string[]) => boolean` | Returns `true` if the principal has **all** listed permissions. |
| `hasRole(principal, ...roles)` | `(p: Principal, ...roles: string[]) => boolean` | Returns `true` if the principal has **any** of the listed roles. |

### `createIamMiddleware(opts)`

Returns an `IamHonoMiddleware` object with three middleware factories:

| Method | Signature | Description |
| ------ | --------- | ----------- |
| `verify()` | `() => MiddlewareHandler` | Extracts `Bearer` token, verifies it, sets `c.var.iamPrincipal`. Returns 401 on failure. |
| `requirePermission(...perms)` | `(...perms: string[]) => MiddlewareHandler` | Returns 403 if the principal is missing any of the listed permissions. Must be called after `verify()`. |
| `requireRole(...roles)` | `(...roles: string[]) => MiddlewareHandler` | Returns 403 if the principal has none of the listed roles. Must be called after `verify()`. |

### `refreshAccessToken(iamCoreUrl, refreshToken)`

Exchanges a refresh token for a new token pair by calling `POST {iamCoreUrl}/api/v1/auth/refresh`.
Resolves to `{ accessToken, refreshToken, expiresIn }`, or `null` if the request fails or IAM Core
rejects the refresh token. The request times out after 10 seconds.

### `PublicKeyCache`

Low-level class for caching the IAM Core RS256 public key. Normally you don't need to use this directly — `IamVerifier` manages it internally.

| Method | Description |
| ------ | ----------- |
| `getKey()` | Returns the cached key, or fetches a fresh one if expired. Deduplicates concurrent calls. |
| `refresh()` | Forces a fresh fetch of the public key regardless of TTL. |

## Exports

All public API is re-exported from the package root:

```typescript
import {
  // Classes
  IamVerifier,
  PublicKeyCache,

  // Types
  type Principal,
  type ActorType,
  type IamToken,
  type IamMiddlewareOptions,
  type IamHonoOptions,

  // Token refresh helper
  refreshAccessToken,
} from '@hivemem/iam-sdk'

// Hono middleware (requires the optional `hono` peer dependency)
import { createIamMiddleware, type IamHonoMiddleware } from '@hivemem/iam-sdk/hono'
```

The main entry point has no framework dependency. Only `@hivemem/iam-sdk/hono` needs `hono`
installed.

## Error Responses

The Hono middleware returns structured JSON errors:

| Status | Body | When |
| ------ | ---- | ---- |
| `401` | `{ error: "UNAUTHORIZED", message: "Bearer token required" }` | Missing `Authorization` header |
| `401` | `{ error: "UNAUTHORIZED", message: "<detail>" }` | Invalid or expired token |
| `401` | `{ error: "UNAUTHORIZED", message: "Authentication required" }` | `requirePermission` / `requireRole` called without prior `verify()` |
| `403` | `{ error: "FORBIDDEN", message: "Missing permissions: ..." }` | Principal lacks required permission(s) |
| `403` | `{ error: "FORBIDDEN", message: "Required role: ... or ..." }` | Principal lacks any of the required roles |

## Development

```bash
npm install          # install dependencies
npm run build        # compile TypeScript → dist/
npm run typecheck    # strict type check (no emit)
npm test             # run Vitest tests
npm run dev          # watch mode (tsc --watch)
npm run clean        # remove dist/ and build info
```

### Project Structure

```
src/
├── index.ts              # Public re-exports
├── types.ts              # Principal, IamToken, option interfaces
├── cache.ts              # PublicKeyCache — fetches + caches RS256 public key
├── verify.ts             # IamVerifier — JWT verification + RBAC helpers
├── refresh.ts            # refreshAccessToken helper
├── verify.test.ts        # Tests for IamVerifier
└── middleware/
    ├── hono.ts           # Hono middleware factory (createIamMiddleware)
    └── hono.test.ts      # Tests for Hono middleware
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
