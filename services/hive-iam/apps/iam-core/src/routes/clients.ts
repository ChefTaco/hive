import { Hono } from 'hono'
import argon2 from 'argon2'
import { prisma } from '../db/client.js'
import { authMiddleware } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'
import { logAuditEvent } from '../services/audit-service.js'
import { getClientIp } from '../utils/ip.js'
import { parseBody } from '../utils/validate.js'
import { CreateClientSchema, RotateClientSecretSchema, UpdateClientSchema } from '../schemas/clients.js'
import { ApiError } from '../types/index.js'
import { parseJsonFields, parseJsonFieldsArray } from '../utils/serialize.js'

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
}

export const clientsRouter = new Hono()

clientsRouter.use('*', authMiddleware)

clientsRouter.get('/', requirePermission('iam:clients:read'), async (c) => {
  const clients = await prisma.client.findMany({
    select: { id: true, name: true, description: true, active: true, clientType: true, allowedIps: true, redirectUris: true, grantTypes: true, firstParty: true, createdAt: true, updatedAt: true },
    orderBy: { name: 'asc' },
  })
  return c.json({ clients: parseJsonFieldsArray(clients, 'allowedIps', 'redirectUris', 'grantTypes') })
})

clientsRouter.post('/', requirePermission('iam:clients:write'), async (c) => {
  const principal = c.get('principal')
  const body = await parseBody(c, CreateClientSchema)

  const existing = await prisma.client.findUnique({ where: { name: body.name } })
  if (existing) throw new ApiError(409, 'CONFLICT', 'Client name already exists')

  const secretHash = body.secret
    ? await argon2.hash(body.secret, ARGON2_OPTIONS)
    : null
  const client = await prisma.client.create({
    data: {
      name: body.name,
      description: body.description,
      secretHash,
      clientType: body.clientType,
      allowedIps: JSON.stringify(body.allowedIps),
      redirectUris: JSON.stringify(body.redirectUris),
      grantTypes: JSON.stringify(body.grantTypes),
      firstParty: body.firstParty,
    },
    select: { id: true, name: true, description: true, active: true, clientType: true, redirectUris: true, grantTypes: true, firstParty: true, createdAt: true },
  })

  await logAuditEvent({
    eventType: 'client.created',
    category: 'ADMIN',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'client',
    resourceId: client.id,
    action: 'create',
    source: 'iam-api',
  })

  return c.json({ client }, 201)
})

clientsRouter.patch('/:id', requirePermission('iam:clients:write'), async (c) => {
  const principal = c.get('principal')
  const clientId = c.req.param('id')
  const body = await parseBody(c, UpdateClientSchema)

  const data: Record<string, unknown> = {}
  if (body.description !== undefined) data['description'] = body.description
  if (body.active !== undefined) data['active'] = body.active
  if (body.allowedIps !== undefined) data['allowedIps'] = JSON.stringify(body.allowedIps)
  if (body.redirectUris !== undefined) data['redirectUris'] = JSON.stringify(body.redirectUris)
  if (body.grantTypes !== undefined) data['grantTypes'] = JSON.stringify(body.grantTypes)
  if (body.firstParty !== undefined) data['firstParty'] = body.firstParty

  const client = await prisma.client.update({
    where: { id: clientId },
    data,
    select: { id: true, name: true, description: true, active: true, clientType: true, allowedIps: true, redirectUris: true, grantTypes: true, firstParty: true, updatedAt: true },
  })

  await logAuditEvent({
    eventType: 'client.updated',
    category: 'ADMIN',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'client',
    resourceId: clientId,
    action: 'update',
    source: 'iam-api',
  })

  return c.json({ client: parseJsonFields(client, 'allowedIps', 'redirectUris', 'grantTypes') })
})

clientsRouter.post('/:id/rotate-secret', requirePermission('iam:clients:write'), async (c) => {
  const principal = c.get('principal')
  const clientId = c.req.param('id')
  const body = await parseBody(c, RotateClientSecretSchema)
  const existing = await prisma.client.findUnique({ where: { id: clientId } })

  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Client not found')
  if (existing.clientType !== 'confidential') {
    throw new ApiError(409, 'CONFLICT', 'Public clients do not have client secrets')
  }

  const secretHash = await argon2.hash(body.secret, ARGON2_OPTIONS)
  await prisma.client.update({
    where: { id: clientId },
    data: { secretHash },
  })

  await logAuditEvent({
    eventType: 'client.secret_rotated',
    category: 'ADMIN',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'client',
    resourceId: clientId,
    action: 'rotate-secret',
    detail: { name: existing.name },
    source: 'iam-api',
  })

  return c.json({ success: true })
})

clientsRouter.delete('/:id', requirePermission('iam:clients:write'), async (c) => {
  const principal = c.get('principal')
  const clientId = c.req.param('id')

  const existing = await prisma.client.findUnique({ where: { id: clientId } })
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Client not found')

  await logAuditEvent({
    eventType: 'client.deleted',
    category: 'ADMIN',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'client',
    resourceId: clientId,
    action: 'delete',
    detail: { name: existing.name },
    source: 'iam-api',
  })

  await prisma.client.delete({ where: { id: clientId } })

  return c.json({ success: true })
})
