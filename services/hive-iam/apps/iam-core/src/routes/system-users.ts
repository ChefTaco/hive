import { Hono, type Context } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { prisma } from '../db/client.js'
import { authMiddleware } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'
import { logAuditEvent } from '../services/audit-service.js'
import { getClientIp } from '../utils/ip.js'
import { parseBody } from '../utils/validate.js'
import { assertMayManageUser, resolveActor } from '../services/privilege-guard.js'
import {
  CreateSystemUserSchema,
  UpdateSystemUserSchema,
  SystemLoginCheckSchema,
} from '../schemas/system-users.js'
import { ApiError } from '../types/index.js'
import { env } from '../config/env.js'
import { parseJsonFields, parseJsonFieldsArray } from '../utils/serialize.js'

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

export const systemUsersRouter = new Hono()

/** Changing or removing a system login needs the same standing as managing its IAM user. */
async function assertMayManageSystemUser(c: Context, systemUserId: string, action: string): Promise<void> {
  const systemUser = await prisma.systemUser.findUnique({ where: { id: systemUserId }, select: { userId: true } })
  if (!systemUser) throw new ApiError(404, 'NOT_FOUND', 'System user not found')
  await assertMayManageUser(await resolveActor(c), systemUser.userId, action)
}

// GET /system-users — IAM admin only
systemUsersRouter.get('/', authMiddleware, requirePermission('iam:system:login'), async (c) => {
  const systemUsers = await prisma.systemUser.findMany({
    include: { user: { select: { email: true, username: true, displayName: true, active: true } } },
    orderBy: { createdAt: 'desc' },
  })
  return c.json({ systemUsers: parseJsonFieldsArray(systemUsers, 'authorizedHosts') })
})

// POST /system-users — link IAM user to linux username
systemUsersRouter.post('/', authMiddleware, requirePermission('iam:users:write'), async (c) => {
  const principal = c.get('principal')
  const body = await parseBody(c, CreateSystemUserSchema)
  await assertMayManageUser(await resolveActor(c), body.userId, 'give this user a system login')

  const existing = await prisma.systemUser.findFirst({
    where: { OR: [{ userId: body.userId }, { linuxUsername: body.linuxUsername }] },
  })
  if (existing) throw new ApiError(409, 'CONFLICT', 'User or linux username already mapped')

  const systemUser = await prisma.systemUser.create({
    data: {
      userId: body.userId,
      linuxUsername: body.linuxUsername,
      sudoEnabled: body.sudoEnabled,
      sshPublicKey: body.sshPublicKey,
      authorizedHosts: JSON.stringify(body.authorizedHosts ?? []),
    },
  })

  await logAuditEvent({
    eventType: 'system_user.created',
    category: 'SYSTEM_ACCESS',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'system_user',
    resourceId: systemUser.id,
    action: 'create',
    detail: { linuxUsername: body.linuxUsername, userId: body.userId },
    source: 'iam-api',
  })

  return c.json({ systemUser: parseJsonFields(systemUser, 'authorizedHosts') }, 201)
})

// PATCH /system-users/:id
systemUsersRouter.patch('/:id', authMiddleware, requirePermission('iam:users:write'), async (c) => {
  const principal = c.get('principal')
  const suId = c.req.param('id')
  const body = await parseBody(c, UpdateSystemUserSchema)
  await assertMayManageSystemUser(c, suId, 'change this system login')

  const data: Record<string, unknown> = {}
  if (body.sudoEnabled !== undefined) data['sudoEnabled'] = body.sudoEnabled
  if (body.sshPublicKey !== undefined) data['sshPublicKey'] = body.sshPublicKey
  if (body.authorizedHosts !== undefined) data['authorizedHosts'] = body.authorizedHosts

  const systemUser = await prisma.systemUser.update({ where: { id: suId }, data })

  await logAuditEvent({
    eventType: 'system_user.updated',
    category: 'SYSTEM_ACCESS',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'system_user',
    resourceId: suId,
    action: 'update',
    source: 'iam-api',
  })

  return c.json({ systemUser: parseJsonFields(systemUser, 'authorizedHosts') })
})

// DELETE /system-users/:id
systemUsersRouter.delete('/:id', authMiddleware, requirePermission('iam:users:delete'), async (c) => {
  const principal = c.get('principal')
  const suId = c.req.param('id')
  await assertMayManageSystemUser(c, suId, 'delete this system login')
  await prisma.systemUser.delete({ where: { id: suId } })

  await logAuditEvent({
    eventType: 'system_user.deleted',
    category: 'SYSTEM_ACCESS',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'system_user',
    resourceId: suId,
    action: 'delete',
    source: 'iam-api',
  })

  return c.json({ success: true })
})

// POST /system-users/check — called by IAM agent PAM shim
systemUsersRouter.post('/check', async (c) => {
  const agentToken = c.req.header('x-agent-token')
  if (!agentToken || !constantTimeEqual(agentToken, env.IAM_AGENT_SECRET)) {
    return c.json({ allowed: false, reason: 'unauthorized' }, 401)
  }

  const body = await parseBody(c, SystemLoginCheckSchema)

  const systemUser = await prisma.systemUser.findUnique({
    where: { linuxUsername: body.linuxUsername },
    include: {
      user: {
        include: { roles: { include: { role: true } } },
      },
    },
  })

  const deny = (reason: string) => {
    logAuditEvent({
      eventType: 'system.login.denied',
      category: 'SYSTEM_ACCESS',
      actorType: 'SYSTEM',
      actorEmail: systemUser?.user.email,
      ipAddress: body.clientIp,
      hostName: body.hostName,
      action: 'system_login',
      outcome: 'DENIED',
      detail: { linuxUsername: body.linuxUsername, reason },
      source: 'iam-agent',
    }).catch(() => {})
    return c.json({ allowed: false, reason })
  }

  if (!systemUser) return deny('no_system_user_mapping')
  if (!systemUser.user.active) return deny('user_inactive')
  if (systemUser.user.lockedUntil && systemUser.user.lockedUntil > new Date()) return deny('account_locked')

  const permissions: string[] = [
    ...new Set(systemUser.user.roles.flatMap((r) => {
      const perms = r.role.permissions
      return (typeof perms === 'string' ? JSON.parse(perms) : perms) as string[]
    })),
  ]
  if (!permissions.includes('iam:system:login')) return deny('insufficient_permissions')

  const authorizedHosts: string[] = typeof systemUser.authorizedHosts === 'string'
    ? JSON.parse(systemUser.authorizedHosts)
    : (systemUser.authorizedHosts as string[])
  if (authorizedHosts.length > 0 && !authorizedHosts.includes(body.hostName)) {
    return deny('host_not_authorized')
  }

  await logAuditEvent({
    eventType: 'system.login',
    category: 'SYSTEM_ACCESS',
    actorId: systemUser.userId,
    actorType: 'USER',
    actorEmail: systemUser.user.email,
    ipAddress: body.clientIp,
    hostName: body.hostName,
    action: 'system_login',
    outcome: 'SUCCESS',
    detail: { linuxUsername: body.linuxUsername },
    source: 'iam-agent',
  })

  return c.json({
    allowed: true,
    sudoEnabled: systemUser.sudoEnabled,
    userId: systemUser.userId,
    email: systemUser.user.email,
  })
})
