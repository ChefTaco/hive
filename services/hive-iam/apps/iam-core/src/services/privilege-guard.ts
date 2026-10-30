import type { Context } from 'hono'
import { prisma } from '../db/client.js'
import { ApiError, type Principal } from '../types/index.js'
import { clientCredentialsPermissionCeiling } from './token-service.js'

/**
 * Privilege guard. Without it, anyone with iam:roles:write could grant themselves
 * SUPER_ADMIN, and anyone with iam:users:write could reset a SUPER_ADMIN's password.
 *
 * Rules, for everyone except unrestricted actors:
 * - You may only grant (through roles, groups or service accounts) permissions you hold.
 * - You may only manage (change, lock, reset, delete, re-key, map a system login to) an
 *   account whose permissions are all ones you hold.
 * - Only SUPER_ADMIN may grant SUPER_ADMIN or manage a SUPER_ADMIN account.
 * - Only SUPER_ADMIN may change sign-in (authorization_code) clients or the Router's client,
 *   because controlling them means controlling other people's sign-ins.
 *
 * Unrestricted actors are SUPER_ADMIN holders (IAM roles also carry permissions for other
 * services, such as memory:read, which SUPER_ADMIN itself does not hold) and the Router's
 * OS-mode console operators, who are the host administrators on the Router's allowlist.
 *
 * The Router's console proxy calls IAM with its own client-credentials token, so for those
 * requests the acting person comes from the `x-hive-operator` header the Router sets. Console
 * users signed in through IAM (`authMode: "iam-oidc"`) are checked as themselves.
 */

export const SUPER_ADMIN_ROLE = 'SUPER_ADMIN'
const ROUTER_PROXY_CLIENT_ID = 'hive-router'
const MAX_OPERATOR_HEADER_BYTES = 2048

export interface Actor {
  readonly userId: string | undefined
  readonly unrestricted: boolean
  readonly permissions: ReadonlySet<string>
}

export interface RouterOperator {
  readonly authMode: 'os' | 'iam-oidc' | undefined
  readonly iamSubject: string | undefined
}

export function parsePermissionList(value: unknown): string[] {
  let parsed: unknown = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      return []
    }
  }
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
}

/** True only for the Router's own client-credentials token (subject and client are both the Router). */
export function isRouterProxyPrincipal(principal: Pick<Principal, 'sub' | 'clientId' | 'actorType'>): boolean {
  return principal.actorType === 'SERVICE_ACCOUNT' && principal.sub === ROUTER_PROXY_CLIENT_ID && principal.clientId === ROUTER_PROXY_CLIENT_ID
}

export function parseRouterOperator(raw: string | undefined): RouterOperator | null {
  if (!raw || raw.length > MAX_OPERATOR_HEADER_BYTES) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const authMode = record['authMode'] === 'os' || record['authMode'] === 'iam-oidc' ? record['authMode'] : undefined
  const subject = record['iamSubject']
  const iamSubject = typeof subject === 'string' && subject.length > 0 && subject.length <= 200 ? subject : undefined
  return { authMode, iamSubject }
}

/** Permissions in `required` that `actor` does not hold. Empty for unrestricted actors. */
export function missingPermissions(actor: Actor, required: Iterable<string>): string[] {
  if (actor.unrestricted) return []
  return [...new Set(required)].filter((permission) => !actor.permissions.has(permission)).sort()
}

function deny(message: string): never {
  throw new ApiError(403, 'PRIVILEGE_ESCALATION', message)
}

function assertSubset(actor: Actor, required: Iterable<string>, action: string): void {
  const missing = missingPermissions(actor, required)
  if (missing.length > 0) deny(`Cannot ${action}: it needs permissions you do not hold (${missing.join(', ')})`)
}

function assertUnrestricted(actor: Actor, action: string): void {
  if (!actor.unrestricted) deny(`Cannot ${action}: only ${SUPER_ADMIN_ROLE} may do this`)
}

interface RoleGrant {
  readonly name: string
  readonly permissions: string[]
}

function toGrants(rows: ReadonlyArray<{ role: { name: string; permissions: string } }>): RoleGrant[] {
  return rows.map((row) => ({ name: row.role.name, permissions: parsePermissionList(row.role.permissions) }))
}

const ROLE_FIELDS = { select: { name: true, permissions: true } } as const

async function userDirectGrants(userId: string): Promise<RoleGrant[]> {
  return toGrants(await prisma.userRoleAssignment.findMany({ where: { userId }, include: { role: ROLE_FIELDS } }))
}

/** Direct roles plus roles inherited from groups. */
async function userEffectiveGrants(userId: string): Promise<RoleGrant[]> {
  const [direct, memberships] = await Promise.all([
    userDirectGrants(userId),
    prisma.groupMember.findMany({ where: { userId }, include: { group: { include: { roles: { include: { role: ROLE_FIELDS } } } } } }),
  ])
  return [...direct, ...memberships.flatMap((membership) => toGrants(membership.group.roles))]
}

function actorFromGrants(userId: string | undefined, grants: readonly RoleGrant[]): Actor {
  return {
    userId,
    unrestricted: grants.some((grant) => grant.name === SUPER_ADMIN_ROLE),
    permissions: new Set(grants.flatMap((grant) => grant.permissions)),
  }
}

/** Who is really acting on this request, and with which permissions. */
export async function resolveActor(c: Context): Promise<Actor> {
  const principal = c.get('principal') as Principal | undefined
  if (!principal) throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required')
  if (!isRouterProxyPrincipal(principal)) {
    return {
      userId: principal.actorType === 'USER' ? principal.sub : undefined,
      unrestricted: principal.roles.includes(SUPER_ADMIN_ROLE),
      permissions: new Set(principal.permissions),
    }
  }

  const operator = parseRouterOperator(c.req.header('x-hive-operator'))
  if (operator?.authMode !== 'iam-oidc') {
    // OS-mode console operators, and Routers that predate operator auth modes.
    return { userId: undefined, unrestricted: true, permissions: new Set(principal.permissions) }
  }
  if (!operator.iamSubject) throw new ApiError(403, 'FORBIDDEN', 'The Router did not identify the IAM user behind this request')
  const user = await prisma.user.findUnique({ where: { id: operator.iamSubject }, select: { id: true, active: true, lockedUntil: true } })
  if (!user || !user.active || (user.lockedUntil && user.lockedUntil > new Date())) {
    throw new ApiError(403, 'FORBIDDEN', 'The IAM user behind this Router request is not active')
  }
  // Same grants the user's own access token carries (direct roles).
  return actorFromGrants(user.id, await userDirectGrants(user.id))
}

async function roleGrants(roleIds: readonly string[]): Promise<RoleGrant[]> {
  if (roleIds.length === 0) return []
  const roles = await prisma.role.findMany({ where: { id: { in: [...roleIds] } }, select: { name: true, permissions: true } })
  return roles.map((role) => ({ name: role.name, permissions: parsePermissionList(role.permissions) }))
}

function assertMayHoldGrants(actor: Actor, grants: readonly RoleGrant[], action: string): void {
  if (grants.some((grant) => grant.name === SUPER_ADMIN_ROLE)) assertUnrestricted(actor, action)
  assertSubset(actor, grants.flatMap((grant) => grant.permissions), action)
}

export function assertMayGrantPermissions(actor: Actor, permissions: Iterable<string>, action: string): void {
  assertSubset(actor, permissions, action)
}

export async function assertMayAssignRoles(actor: Actor, roleIds: readonly string[], action: string): Promise<void> {
  assertMayHoldGrants(actor, await roleGrants(roleIds), action)
}

/** A role may only be edited or deleted by someone who holds everything it grants. */
export async function assertMayManageRole(actor: Actor, roleId: string, action: string): Promise<void> {
  assertMayHoldGrants(actor, await roleGrants([roleId]), action)
}

export async function assertMayManageUser(actor: Actor, userId: string, action: string): Promise<void> {
  if (actor.unrestricted || actor.userId === userId) return
  assertMayHoldGrants(actor, await userEffectiveGrants(userId), action)
}

export async function assertMayManageGroup(actor: Actor, groupId: string, action: string): Promise<void> {
  if (actor.unrestricted) return
  assertMayHoldGrants(actor, toGrants(await prisma.groupRoleAssignment.findMany({ where: { groupId }, include: { role: ROLE_FIELDS } })), action)
}

export async function assertMayManageServiceAccount(actor: Actor, serviceAccountId: string, action: string): Promise<void> {
  if (actor.unrestricted) return
  assertMayHoldGrants(actor, toGrants(await prisma.serviceAccountRoleAssignment.findMany({ where: { serviceAccountId }, include: { role: ROLE_FIELDS } })), action)
}

/** Changing a client's secret, redirect URIs or grants: see the rules at the top of this file. */
export function assertMayManageClient(actor: Actor, client: { name: string; grantTypes: unknown }, action: string): void {
  if (actor.unrestricted) return
  const grantTypes = parsePermissionList(client.grantTypes)
  if (client.name === ROUTER_PROXY_CLIENT_ID || grantTypes.includes('authorization_code')) assertUnrestricted(actor, action)
  assertSubset(actor, clientCredentialsPermissionCeiling(client.name), action)
}
