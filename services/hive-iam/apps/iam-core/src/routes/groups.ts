import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'
import { logAuditEvent } from '../services/audit-service.js'
import { getClientIp } from '../utils/ip.js'
import { parseBody } from '../utils/validate.js'
import {
  CreateGroupSchema,
  UpdateGroupSchema,
  AddMembersSchema,
  AssignRolesSchema,
} from '../schemas/groups.js'
import {
  listGroups,
  getGroupById,
  createGroup,
  updateGroup,
  deleteGroup,
  addMembers,
  removeMember,
  assignRoles,
  removeRole,
} from '../services/group-service.js'

export const groupsRouter = new Hono()

groupsRouter.use('*', authMiddleware)

// ── List groups ──
groupsRouter.get('/', requirePermission('iam:groups:read'), async (c) => {
  const search = c.req.query('search')
  const groups = await listGroups({ search })
  return c.json({ groups })
})

// ── Get group by ID ──
groupsRouter.get('/:id', requirePermission('iam:groups:read'), async (c) => {
  const group = await getGroupById(c.req.param('id'))
  return c.json({ group })
})

// ── Create group ──
groupsRouter.post('/', requirePermission('iam:groups:write'), async (c) => {
  const principal = c.get('principal')
  const body = await parseBody(c, CreateGroupSchema)
  const group = await createGroup(body)

  await logAuditEvent({
    eventType: 'group.created',
    category: 'GROUP_MANAGEMENT',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'group',
    resourceId: group.id,
    action: 'create',
    source: 'iam-api',
  })

  return c.json({ group }, 201)
})

// ── Update group ──
groupsRouter.patch('/:id', requirePermission('iam:groups:write'), async (c) => {
  const principal = c.get('principal')
  const body = await parseBody(c, UpdateGroupSchema)
  const group = await updateGroup(c.req.param('id'), body)

  await logAuditEvent({
    eventType: 'group.updated',
    category: 'GROUP_MANAGEMENT',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'group',
    resourceId: group.id,
    action: 'update',
    source: 'iam-api',
  })

  return c.json({ group })
})

// ── Delete group ──
groupsRouter.delete('/:id', requirePermission('iam:groups:write'), async (c) => {
  const principal = c.get('principal')
  const id = c.req.param('id')

  await deleteGroup(id)

  await logAuditEvent({
    eventType: 'group.deleted',
    category: 'GROUP_MANAGEMENT',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'group',
    resourceId: id,
    action: 'delete',
    source: 'iam-api',
  })

  return c.json({ success: true })
})

// ── Add members to group ──
groupsRouter.post('/:id/members', requirePermission('iam:groups:write'), async (c) => {
  const principal = c.get('principal')
  const body = await parseBody(c, AddMembersSchema)
  await addMembers(c.req.param('id'), body.userIds)

  await logAuditEvent({
    eventType: 'group.members_added',
    category: 'GROUP_MANAGEMENT',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'group',
    resourceId: c.req.param('id'),
    action: 'add_members',
    detail: { userIds: body.userIds },
    source: 'iam-api',
  })

  return c.json({ success: true }, 201)
})

// ── Remove member from group ──
groupsRouter.delete('/:id/members/:userId', requirePermission('iam:groups:write'), async (c) => {
  const principal = c.get('principal')
  await removeMember(c.req.param('id'), c.req.param('userId'))

  await logAuditEvent({
    eventType: 'group.member_removed',
    category: 'GROUP_MANAGEMENT',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'group',
    resourceId: c.req.param('id'),
    action: 'remove_member',
    detail: { userId: c.req.param('userId') },
    source: 'iam-api',
  })

  return c.json({ success: true })
})

// ── Assign roles to group ──
groupsRouter.post('/:id/roles', requirePermission('iam:groups:write'), async (c) => {
  const principal = c.get('principal')
  const body = await parseBody(c, AssignRolesSchema)
  await assignRoles(c.req.param('id'), body.roleIds)

  await logAuditEvent({
    eventType: 'group.roles_assigned',
    category: 'GROUP_MANAGEMENT',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'group',
    resourceId: c.req.param('id'),
    action: 'assign_roles',
    detail: { roleIds: body.roleIds },
    source: 'iam-api',
  })

  return c.json({ success: true }, 201)
})

// ── Remove role from group ──
groupsRouter.delete('/:id/roles/:roleId', requirePermission('iam:groups:write'), async (c) => {
  const principal = c.get('principal')
  await removeRole(c.req.param('id'), c.req.param('roleId'))

  await logAuditEvent({
    eventType: 'group.role_removed',
    category: 'GROUP_MANAGEMENT',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'group',
    resourceId: c.req.param('id'),
    action: 'remove_role',
    detail: { roleId: c.req.param('roleId') },
    source: 'iam-api',
  })

  return c.json({ success: true })
})
