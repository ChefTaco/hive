import { describe, expect, it, vi } from 'vitest'
import type { Context } from 'hono'
import type { Principal } from '../types/index.js'

// ── In-memory directory ─────────────────────────────────────────────────────

const ROLES: Record<string, { name: string; permissions: string[] }> = {
  'role-super': { name: 'SUPER_ADMIN', permissions: ['iam:users:write', 'iam:roles:write', 'iam:system:sudo', 'iam:system:deploy'] },
  'role-iam-admin': { name: 'IAM_ADMIN', permissions: ['iam:users:write', 'iam:roles:write', 'iam:clients:write'] },
  'role-viewer': { name: 'VIEWER', permissions: ['iam:users:read'] },
  'role-sudo': { name: 'LOOKS_HARMLESS', permissions: ['iam:system:sudo'] },
  'role-memory': { name: 'MEMORY_READER', permissions: ['memory:read'] },
}
const USER_ROLES: Record<string, string[]> = {
  'user-super': ['role-super'],
  'user-iam-admin': ['role-iam-admin'],
  'user-viewer': ['role-viewer'],
  'user-grouped': ['role-viewer'],
}
const USERS: Record<string, { id: string; active: boolean; lockedUntil: Date | null }> = {
  'user-super': { id: 'user-super', active: true, lockedUntil: null },
  'user-iam-admin': { id: 'user-iam-admin', active: true, lockedUntil: null },
  'user-viewer': { id: 'user-viewer', active: true, lockedUntil: null },
  'user-grouped': { id: 'user-grouped', active: true, lockedUntil: null },
  'user-inactive': { id: 'user-inactive', active: false, lockedUntil: null },
}
const GROUP_ROLES: Record<string, string[]> = { 'group-ops': ['role-sudo'] }
const GROUP_MEMBERS: Record<string, string[]> = { 'user-grouped': ['group-ops'] }
const SA_ROLES: Record<string, string[]> = { 'sa-deployer': ['role-sudo'], 'sa-reader': ['role-viewer'] }

const roleRow = (id: string) => ({ role: { name: ROLES[id]!.name, permissions: JSON.stringify(ROLES[id]!.permissions) } })

vi.mock('../db/client.js', () => ({
  prisma: {
    role: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => ROLES[id]).map((id) => ({ name: ROLES[id]!.name, permissions: JSON.stringify(ROLES[id]!.permissions) }))),
    },
    user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => USERS[where.id] ?? null) },
    userRoleAssignment: { findMany: vi.fn(async ({ where }: { where: { userId: string } }) => (USER_ROLES[where.userId] ?? []).map(roleRow)) },
    groupMember: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        (GROUP_MEMBERS[where.userId] ?? []).map((groupId) => ({ group: { roles: (GROUP_ROLES[groupId] ?? []).map(roleRow) } }))),
    },
    groupRoleAssignment: { findMany: vi.fn(async ({ where }: { where: { groupId: string } }) => (GROUP_ROLES[where.groupId] ?? []).map(roleRow)) },
    serviceAccountRoleAssignment: {
      findMany: vi.fn(async ({ where }: { where: { serviceAccountId: string } }) => (SA_ROLES[where.serviceAccountId] ?? []).map(roleRow)),
    },
  },
}))

// token-service (used for client permission ceilings) reads the environment at import time.
process.env['DATABASE_URL'] ??= 'file:/tmp/hive-iam-privilege-guard-test.db'
process.env['JWT_PRIVATE_KEY_PATH'] ??= '/tmp/hive-iam-test-private.pem'
process.env['JWT_PUBLIC_KEY_PATH'] ??= '/tmp/hive-iam-test-public.pem'
process.env['COOKIE_SECRET'] ??= 'cookie-secret-for-privilege-guard-test'
process.env['IAM_AGENT_SECRET'] ??= 'agent-secret-for-privilege-guard-test'

const guard = await import('./privilege-guard.js')

// ── Helpers ─────────────────────────────────────────────────────────────────

function principalFor(userId: string): Principal {
  const roleIds = USER_ROLES[userId] ?? []
  return {
    sub: userId,
    actorType: 'USER',
    email: undefined,
    username: userId,
    roles: roleIds.map((id) => ROLES[id]!.name),
    permissions: roleIds.flatMap((id) => ROLES[id]!.permissions),
    sessionId: 'session-1',
    clientId: undefined,
  }
}

const routerProxy: Principal = {
  sub: 'hive-router',
  actorType: 'SERVICE_ACCOUNT',
  email: undefined,
  username: undefined,
  roles: [],
  permissions: ['iam:users:write', 'iam:roles:write', 'iam:clients:write'],
  sessionId: undefined,
  clientId: 'hive-router',
}

function context(principal: Principal, headers: Record<string, string> = {}): Context {
  return {
    get: (key: string) => (key === 'principal' ? principal : undefined),
    req: { header: (name: string) => headers[name.toLowerCase()] },
  } as unknown as Context
}

const operator = (value: Record<string, unknown>) => ({ 'x-hive-operator': JSON.stringify({ id: 'router-user', sessionId: 's', authenticatedAt: Date.now(), ...value }) })

async function expectEscalation(promise: Promise<unknown> | (() => void)): Promise<void> {
  const run = typeof promise === 'function' ? Promise.resolve().then(promise) : promise
  await expect(run).rejects.toMatchObject({ status: 403, code: 'PRIVILEGE_ESCALATION' })
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('privilege guard: who is acting', () => {
  it('uses the token of a direct IAM user, and treats SUPER_ADMIN as unrestricted', async () => {
    const admin = await guard.resolveActor(context(principalFor('user-iam-admin')))
    expect(admin).toMatchObject({ userId: 'user-iam-admin', unrestricted: false })
    expect([...admin.permissions].sort()).toEqual(['iam:clients:write', 'iam:roles:write', 'iam:users:write'])
    expect(await guard.resolveActor(context(principalFor('user-super')))).toMatchObject({ unrestricted: true })
  })

  it('checks the IAM user behind a Router console request in iam-oidc mode', async () => {
    const actor = await guard.resolveActor(context(routerProxy, operator({ authMode: 'iam-oidc', iamSubject: 'user-iam-admin' })))
    expect(actor).toMatchObject({ userId: 'user-iam-admin', unrestricted: false })
    expect(await guard.resolveActor(context(routerProxy, operator({ authMode: 'iam-oidc', iamSubject: 'user-super' })))).toMatchObject({ unrestricted: true })
  })

  it('refuses iam-oidc Router requests that do not name an active IAM user', async () => {
    await expect(guard.resolveActor(context(routerProxy, operator({ authMode: 'iam-oidc' })))).rejects.toMatchObject({ status: 403 })
    await expect(guard.resolveActor(context(routerProxy, operator({ authMode: 'iam-oidc', iamSubject: 'user-inactive' })))).rejects.toMatchObject({ status: 403 })
    await expect(guard.resolveActor(context(routerProxy, operator({ authMode: 'iam-oidc', iamSubject: 'nobody' })))).rejects.toMatchObject({ status: 403 })
  })

  it('keeps OS-mode Router operators unrestricted', async () => {
    expect(await guard.resolveActor(context(routerProxy, operator({ authMode: 'os' })))).toMatchObject({ unrestricted: true })
    expect(await guard.resolveActor(context(routerProxy))).toMatchObject({ unrestricted: true })
  })

  it('only honours the operator header on the Router client token itself', async () => {
    // A service account that merely claims the Router's client id is not the Router.
    const impostor: Principal = { ...routerProxy, sub: 'sa-cuid-123' }
    expect(guard.isRouterProxyPrincipal(impostor)).toBe(false)
    const actor = await guard.resolveActor(context(impostor, operator({ authMode: 'os' })))
    expect(actor.unrestricted).toBe(false)
    // A user token issued through the Router's OIDC client is checked as that user.
    expect(guard.isRouterProxyPrincipal({ ...principalFor('user-viewer'), clientId: 'hive-router' })).toBe(false)
  })

  it('rejects malformed or oversized operator headers', () => {
    expect(guard.parseRouterOperator('not json')).toBeNull()
    expect(guard.parseRouterOperator(JSON.stringify({ authMode: 'os', pad: 'x'.repeat(4096) }))).toBeNull()
    expect(guard.parseRouterOperator(JSON.stringify({ authMode: 'root' }))).toEqual({ authMode: undefined, iamSubject: undefined })
  })
})

describe('privilege guard: granting', () => {
  it('stops an IAM_ADMIN from granting SUPER_ADMIN, including to themselves', async () => {
    const actor = await guard.resolveActor(context(principalFor('user-iam-admin')))
    await expectEscalation(guard.assertMayAssignRoles(actor, ['role-super'], 'assign these roles'))
  })

  it('stops granting a custom role that carries permissions the actor lacks', async () => {
    const actor = await guard.resolveActor(context(principalFor('user-iam-admin')))
    await expectEscalation(guard.assertMayAssignRoles(actor, ['role-sudo'], 'assign these roles'))
    await expectEscalation(() => guard.assertMayGrantPermissions(actor, ['iam:system:sudo'], 'create a role'))
  })

  it('allows granting what the actor holds', async () => {
    const actor = await guard.resolveActor(context(principalFor('user-iam-admin')))
    await expect(guard.assertMayAssignRoles(actor, [], 'assign these roles')).resolves.toBeUndefined()
    expect(() => guard.assertMayGrantPermissions(actor, ['iam:users:write'], 'create a role')).not.toThrow()
  })

  it('lets SUPER_ADMIN grant anything, including permissions for other services', async () => {
    const actor = await guard.resolveActor(context(principalFor('user-super')))
    await expect(guard.assertMayAssignRoles(actor, ['role-super', 'role-memory', 'role-sudo'], 'assign these roles')).resolves.toBeUndefined()
  })

  it('stops an IAM_ADMIN from editing a role more powerful than they are', async () => {
    const actor = await guard.resolveActor(context(principalFor('user-iam-admin')))
    await expectEscalation(guard.assertMayManageRole(actor, 'role-sudo', 'change this role'))
  })

  it('applies the same rules through the Router console in iam-oidc mode', async () => {
    const actor = await guard.resolveActor(context(routerProxy, operator({ authMode: 'iam-oidc', iamSubject: 'user-iam-admin' })))
    await expectEscalation(guard.assertMayAssignRoles(actor, ['role-super'], 'assign these roles'))
  })
})

describe('privilege guard: managing accounts', () => {
  it('stops an IAM_ADMIN from managing a SUPER_ADMIN account', async () => {
    const actor = await guard.resolveActor(context(principalFor('user-iam-admin')))
    await expectEscalation(guard.assertMayManageUser(actor, 'user-super', 'reset this user\'s password'))
  })

  it('counts permissions a target inherits from groups', async () => {
    const actor = await guard.resolveActor(context(principalFor('user-iam-admin')))
    await expectEscalation(guard.assertMayManageUser(actor, 'user-grouped', 'change this user'))
    await expectEscalation(guard.assertMayManageGroup(actor, 'group-ops', 'add members to this group'))
  })

  it('allows managing less privileged accounts and yourself', async () => {
    const viewerOnly = { userId: 'user-iam-admin', unrestricted: false, permissions: new Set(['iam:users:read', 'iam:users:write']) }
    await expect(guard.assertMayManageUser(viewerOnly, 'user-viewer', 'change this user')).resolves.toBeUndefined()
    const actor = await guard.resolveActor(context(principalFor('user-iam-admin')))
    await expect(guard.assertMayManageUser(actor, 'user-iam-admin', 'change this user')).resolves.toBeUndefined()
  })

  it('protects service accounts that hold more than the actor', async () => {
    const actor = await guard.resolveActor(context(principalFor('user-iam-admin')))
    await expectEscalation(guard.assertMayManageServiceAccount(actor, 'sa-deployer', 'rotate this service account\'s key'))
    const reader = { userId: 'x', unrestricted: false, permissions: new Set(['iam:users:read']) }
    await expect(guard.assertMayManageServiceAccount(reader, 'sa-reader', 'rotate this service account\'s key')).resolves.toBeUndefined()
  })
})

describe('privilege guard: clients', () => {
  it('reserves the Router client and sign-in clients for SUPER_ADMIN', async () => {
    const actor = await guard.resolveActor(context(principalFor('user-iam-admin')))
    await expectEscalation(() => guard.assertMayManageClient(actor, { name: 'hive-router', grantTypes: '["client_credentials"]' }, 'rotate this client\'s secret'))
    await expectEscalation(() => guard.assertMayManageClient(actor, { name: 'portal', grantTypes: '["authorization_code","refresh_token"]' }, 'change this client'))
    const superAdmin = await guard.resolveActor(context(principalFor('user-super')))
    expect(() => guard.assertMayManageClient(superAdmin, { name: 'hive-router', grantTypes: '["client_credentials"]' }, 'rotate this client\'s secret')).not.toThrow()
  })

  it('lets an actor manage a machine client whose permissions they hold', async () => {
    const auditor = { userId: 'x', unrestricted: false, permissions: new Set(['iam:audit:read', 'router:security-events:read']) }
    expect(() => guard.assertMayManageClient(auditor, { name: 'security-exporter', grantTypes: '["client_credentials"]' }, 'rotate this client\'s secret')).not.toThrow()
    const actor = await guard.resolveActor(context(principalFor('user-iam-admin')))
    await expectEscalation(() => guard.assertMayManageClient(actor, { name: 'security-exporter', grantTypes: '["client_credentials"]' }, 'rotate this client\'s secret'))
  })
})
