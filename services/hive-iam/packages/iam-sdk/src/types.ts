export type ActorType = 'USER' | 'SERVICE_ACCOUNT' | 'SYSTEM' | 'AGENT'

export interface Principal {
  readonly sub: string
  readonly actorType: ActorType
  readonly email: string | undefined
  readonly username: string | undefined
  readonly roles: readonly string[]
  readonly permissions: readonly string[]
  readonly sessionId: string | undefined
  readonly clientId: string | undefined
}

export interface IamToken {
  sub: string
  actorType: string
  email?: string
  username?: string
  roles: string[]
  permissions: string[]
  sessionId?: string
  clientId?: string
  iss: string
  iat: number
  exp: number
  jti: string
}

export interface IamMiddlewareOptions {
  /** Full URL to the IAM Core API public-key endpoint */
  publicKeyUrl: string
  /** Expected JWT issuer (default: "iam-core") */
  issuer?: string
  /** Expected JWT audience. Machine consumers should always configure this. */
  audience?: string | string[]
  /** How long to cache the public key in ms (default: 3600000 = 1h) */
  cacheTtlMs?: number
}

export interface IamHonoOptions extends IamMiddlewareOptions {
  /** Optional custom error response handler */
  onUnauthorized?: (reason: string) => Response
}
