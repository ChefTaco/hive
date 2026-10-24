import { Hono } from 'hono'
import { prisma } from '../db/client.js'
import { authMiddleware } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'
import { hashPassword } from '../services/password-service.js'
import { logAuditEvent } from '../services/audit-service.js'
import { getClientIp } from '../utils/ip.js'
import { parseBody } from '../utils/validate.js'
import {
  CreateUserSchema,
  UpdateUserSchema,
  AssignRolesSchema,
  ListUsersQuerySchema,
  RotatePasswordSchema,
} from '../schemas/users.js'
import { ApiError } from '../types/index.js'

export const usersRouter = new Hono()

usersRouter.use('*', authMiddleware)

// GET /users
usersRouter.get('/', requirePermission('iam:users:read'), async (c) => {
  const query = ListUsersQuerySchema.parse(c.req.query())
  const skip = (query.page - 1) * query.limit

  const where = {
    ...(query.search
      ? {
          OR: [
            { email: { contains: query.search } },
            { username: { contains: query.search } },
            { displayName: { contains: query.search } },
          ],
        }
      : {}),
    ...(query.active !== undefined ? { active: query.active } : {}),
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip,
      take: query.limit,
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        active: true,
        mfaEnabled: true,
        mfaVerifiedAt: true,
        passwordChangedAt: true,
        failedAttempts: true,
        lockedUntil: true,
        lastLoginAt: true,
        createdAt: true,
        _count: { select: { webauthnCredentials: true, trustedDevices: true } },
        roles: { include: { role: { select: { name: true, label: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.user.count({ where }),
  ])

  return c.json({
    users: users.map((user) => ({
      ...user,
      passkeyCount: user._count.webauthnCredentials,
      trustedDeviceCount: user._count.trustedDevices,
      _count: undefined,
    })),
    total,
    page: query.page,
    limit: query.limit,
  })
})

// POST /users
usersRouter.post('/', requirePermission('iam:users:write'), async (c) => {
  const principal = c.get('principal')
  const body = await parseBody(c, CreateUserSchema)

  const existing = await prisma.user.findFirst({
    where: { OR: [{ email: body.email }, { username: body.username }] },
  })
  if (existing) throw new ApiError(409, 'CONFLICT', 'Email or username already in use')

  const passwordHash = await hashPassword(body.password)
  const user = await prisma.user.create({
    data: {
      email: body.email,
      username: body.username,
      displayName: body.displayName,
      passwordHash,
      encryptedPassword: null,
      passwordChangedAt: new Date(),
      active: body.active,
      roles: body.roleIds.length > 0
        ? { create: body.roleIds.map((roleId) => ({ roleId, grantedBy: principal.sub })) }
        : undefined,
    },
    include: { roles: { include: { role: { select: { name: true } } } } },
  })

  await logAuditEvent({
    eventType: 'user.created',
    category: 'USER_MANAGEMENT',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'user',
    resourceId: user.id,
    action: 'create',
    source: 'iam-api',
  })

  return c.json({ user: { ...user, passwordHash: undefined, encryptedPassword: undefined } }, 201)
})

// GET /users/:id
usersRouter.get('/:id', requirePermission('iam:users:read'), async (c) => {
  const user = await prisma.user.findUnique({
    where: { id: c.req.param('id') },
    include: {
      roles: { include: { role: true } },
      systemUser: true,
      sessions: {
        where: { revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
        take: 10,
      },
    },
  })
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found')
  return c.json({ user: { ...user, passwordHash: undefined, encryptedPassword: undefined } })
})

// PATCH /users/:id
usersRouter.patch('/:id', requirePermission('iam:users:write'), async (c) => {
  const principal = c.get('principal')
  const body = await parseBody(c, UpdateUserSchema)
  const userId = c.req.param('id')

  const existing = await prisma.user.findUnique({ where: { id: userId } })
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'User not found')

  const data: Record<string, unknown> = {}
  if (body.displayName !== undefined) data['displayName'] = body.displayName
  if (body.active !== undefined) data['active'] = body.active
  if (body.password !== undefined) {
    data['passwordHash'] = await hashPassword(body.password)
    data['encryptedPassword'] = null
    data['passwordChangedAt'] = new Date()
  }

  const user = await prisma.user.update({ where: { id: userId }, data })
  if (body.password !== undefined) {
    await prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } })
  }

  await logAuditEvent({
    eventType: 'user.updated',
    category: 'USER_MANAGEMENT',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'user',
    resourceId: userId,
    action: 'update',
    detail: { changes: Object.keys(data) },
    source: 'iam-api',
  })

  return c.json({ user: { ...user, passwordHash: undefined, encryptedPassword: undefined } })
})

// DELETE /users/:id — hard delete
usersRouter.delete('/:id', requirePermission('iam:users:delete'), async (c) => {
  const principal = c.get('principal')
  const userId = c.req.param('id')

  if (userId === principal.sub) {
    throw new ApiError(400, 'SELF_DELETE', 'Cannot delete your own account')
  }

  const existing = await prisma.user.findUnique({ where: { id: userId } })
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'User not found')

  await logAuditEvent({
    eventType: 'user.deleted',
    category: 'USER_MANAGEMENT',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'user',
    resourceId: userId,
    action: 'delete',
    detail: { email: existing.email, username: existing.username },
    source: 'iam-api',
  })

  await prisma.user.delete({ where: { id: userId } })

  return c.json({ success: true })
})

// POST /users/:id/roles
usersRouter.post('/:id/roles', requirePermission('iam:roles:write'), async (c) => {
  const principal = c.get('principal')
  const userId = c.req.param('id')
  const { roleIds } = await parseBody(c, AssignRolesSchema)

  for (const roleId of roleIds) {
    await prisma.userRoleAssignment.upsert({
      where: { userId_roleId: { userId, roleId } },
      update: {},
      create: { userId, roleId, grantedBy: principal.sub },
    })
  }

  await logAuditEvent({
    eventType: 'user.roles_assigned',
    category: 'ROLE_MANAGEMENT',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'user',
    resourceId: userId,
    action: 'assign_roles',
    detail: { roleIds },
    source: 'iam-api',
  })

  return c.json({ success: true })
})

// DELETE /users/:id/roles/:roleId
usersRouter.delete('/:id/roles/:roleId', requirePermission('iam:roles:write'), async (c) => {
  const principal = c.get('principal')
  const userId = c.req.param('id')
  const roleId = c.req.param('roleId')

  await prisma.userRoleAssignment.deleteMany({ where: { userId, roleId } })

  await logAuditEvent({
    eventType: 'user.role_removed',
    category: 'ROLE_MANAGEMENT',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'user',
    resourceId: userId,
    action: 'remove_role',
    detail: { roleId },
    source: 'iam-api',
  })

  return c.json({ success: true })
})

// POST /users/:id/lock
usersRouter.post('/:id/lock', requirePermission('iam:users:write'), async (c) => {
  const principal = c.get('principal')
  const userId = c.req.param('id')

  const existing = await prisma.user.findUnique({ where: { id: userId } })
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'User not found')

  await prisma.user.update({
    where: { id: userId },
    data: { lockedUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) },
  })

  await logAuditEvent({
    eventType: 'user.locked',
    category: 'USER_MANAGEMENT',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'user',
    resourceId: userId,
    action: 'lock',
    source: 'iam-api',
  })

  return c.json({ success: true })
})

// POST /users/:id/unlock
usersRouter.post('/:id/unlock', requirePermission('iam:users:write'), async (c) => {
  const principal = c.get('principal')
  const userId = c.req.param('id')

  const existing = await prisma.user.findUnique({ where: { id: userId } })
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'User not found')

  await prisma.user.update({
    where: { id: userId },
    data: { lockedUntil: null, failedAttempts: 0 },
  })

  await logAuditEvent({
    eventType: 'user.unlocked',
    category: 'USER_MANAGEMENT',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'user',
    resourceId: userId,
    action: 'unlock',
    source: 'iam-api',
  })

  return c.json({ success: true })
})

// GET /users/:id/sessions
usersRouter.get('/:id/sessions', requirePermission('iam:users:read'), async (c) => {
  const sessions = await prisma.session.findMany({
    where: { userId: c.req.param('id'), revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  })
  return c.json({ sessions })
})

// POST /users/:id/rotate-password — rotate password, store new one
usersRouter.post('/:id/rotate-password', requirePermission('iam:users:write'), async (c) => {
  const principal = c.get('principal')
  const body = await parseBody(c, RotatePasswordSchema)
  const userId = c.req.param('id')

  const existing = await prisma.user.findUnique({ where: { id: userId } })
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'User not found')

  const newPassword = body.password
  const passwordHash = await hashPassword(newPassword)

  await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash,
      encryptedPassword: null,
      passwordChangedAt: new Date(),
    },
  })

  await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedBy: principal.sub },
  })

  await logAuditEvent({
    eventType: 'user.password_rotated',
    category: 'USER_MANAGEMENT',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'user',
    resourceId: userId,
    action: 'rotate_password',
    source: 'iam-api',
  })

  return c.json({ success: true })
})
