import { Hono } from 'hono'
import { prisma } from '../db/client.js'
import { authMiddleware } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'
import { logAuditEvent } from '../services/audit-service.js'
import { getClientIp } from '../utils/ip.js'
import { parseBody } from '../utils/validate.js'
import { CreateRoleSchema, UpdateRoleSchema } from '../schemas/roles.js'
import { ApiError } from '../types/index.js'
import { parseJsonFields, parseJsonFieldsArray } from '../utils/serialize.js'

export const rolesRouter = new Hono()

rolesRouter.use('*', authMiddleware)

rolesRouter.get('/', requirePermission('iam:roles:read'), async (c) => {
  const roles = await prisma.role.findMany({ orderBy: { name: 'asc' } })
  return c.json({ roles: parseJsonFieldsArray(roles, 'permissions') })
})

rolesRouter.post('/', requirePermission('iam:roles:write'), async (c) => {
  const principal = c.get('principal')
  const body = await parseBody(c, CreateRoleSchema)

  const existing = await prisma.role.findUnique({ where: { name: body.name } })
  if (existing) throw new ApiError(409, 'CONFLICT', 'Role name already exists')

  const role = await prisma.role.create({ data: { ...body, permissions: JSON.stringify(body.permissions) } })

  await logAuditEvent({
    eventType: 'role.created',
    category: 'ROLE_MANAGEMENT',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'role',
    resourceId: role.id,
    action: 'create',
    source: 'iam-api',
  })

  return c.json({ role: parseJsonFields(role, 'permissions') }, 201)
})

rolesRouter.get('/:id', requirePermission('iam:roles:read'), async (c) => {
  const role = await prisma.role.findUnique({ where: { id: c.req.param('id') } })
  if (!role) throw new ApiError(404, 'NOT_FOUND', 'Role not found')
  return c.json({ role: parseJsonFields(role, 'permissions') })
})

rolesRouter.patch('/:id', requirePermission('iam:roles:write'), async (c) => {
  const principal = c.get('principal')
  const roleId = c.req.param('id')
  const existing = await prisma.role.findUnique({ where: { id: roleId } })
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Role not found')
  if (existing.isSystem) throw new ApiError(403, 'FORBIDDEN', 'System roles cannot be modified')

  const body = await parseBody(c, UpdateRoleSchema)
  const data: Record<string, unknown> = { ...body }
  if (body.permissions) data['permissions'] = JSON.stringify(body.permissions)
  const role = await prisma.role.update({ where: { id: roleId }, data })

  await logAuditEvent({
    eventType: 'role.updated',
    category: 'ROLE_MANAGEMENT',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'role',
    resourceId: roleId,
    action: 'update',
    source: 'iam-api',
  })

  return c.json({ role: parseJsonFields(role, 'permissions') })
})

rolesRouter.delete('/:id', requirePermission('iam:roles:write'), async (c) => {
  const principal = c.get('principal')
  const roleId = c.req.param('id')
  const existing = await prisma.role.findUnique({ where: { id: roleId } })
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Role not found')
  if (existing.isSystem) throw new ApiError(403, 'FORBIDDEN', 'System roles cannot be deleted')

  await prisma.role.delete({ where: { id: roleId } })

  await logAuditEvent({
    eventType: 'role.deleted',
    category: 'ROLE_MANAGEMENT',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'role',
    resourceId: roleId,
    action: 'delete',
    source: 'iam-api',
  })

  return c.json({ success: true })
})
