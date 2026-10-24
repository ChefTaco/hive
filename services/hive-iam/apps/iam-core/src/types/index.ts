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

export interface HealthCheck {
  name: string
  status: 'pass' | 'fail'
  latencyMs?: number
  message?: string
}

export type AuditCategory =
  | 'AUTHENTICATION'
  | 'AUTHORIZATION'
  | 'USER_MANAGEMENT'
  | 'ROLE_MANAGEMENT'
  | 'GROUP_MANAGEMENT'
  | 'SERVICE_ACCOUNT'
  | 'SYSTEM_ACCESS'
  | 'TOKEN'
  | 'ADMIN'
  | 'SUDO'
  | 'AGENT'

export type AuditOutcome = 'SUCCESS' | 'FAILURE' | 'DENIED'

export interface TokenPair {
  accessToken: string
  refreshToken: string
  sessionId: string
  expiresIn: number
}

export interface AuditEventInput {
  eventType: string
  category: AuditCategory
  actorId?: string
  actorType?: ActorType
  actorEmail?: string
  clientId?: string
  serviceAccountId?: string
  ipAddress?: string
  userAgent?: string
  resourceType?: string
  resourceId?: string
  action: string
  outcome?: AuditOutcome
  detail?: Record<string, unknown>
  source?: string
  hostName?: string
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}
