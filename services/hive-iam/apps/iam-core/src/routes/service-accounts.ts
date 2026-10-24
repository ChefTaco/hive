import { Hono } from 'hono'
import { prisma } from '../db/client.js'
import { authMiddleware } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'
import { createServiceAccount, rotateApiKey } from '../services/sa-service.js'
import { logAuditEvent } from '../services/audit-service.js'
import { getClientIp } from '../utils/ip.js'
import { parseBody } from '../utils/validate.js'
import { CreateServiceAccountSchema, UpdateServiceAccountSchema } from '../schemas/service-accounts.js'
import { ApiError } from '../types/index.js'
import { parseJsonFields } from '../utils/serialize.js'

export const serviceAccountsRouter = new Hono()

serviceAccountsRouter.use('*', authMiddleware)

serviceAccountsRouter.get('/', requirePermission('iam:sa:read'), async (c) => {
  const sas = await prisma.serviceAccount.findMany({
    include: { roles: { include: { role: { select: { name: true, label: true } } } }, client: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  })
  return c.json({ serviceAccounts: sas.map((sa) => parseJsonFields({ ...sa, apiKeyHash: undefined }, 'allowedIps')) })
})

serviceAccountsRouter.post('/', requirePermission('iam:sa:write'), async (c) => {
  const principal = c.get('principal')
  const body = await parseBody(c, CreateServiceAccountSchema)

  const { id, apiKey } = await createServiceAccount(body.name, body.clientId, body.roleIds, {
    operationId: body.operationId,
    description: body.description,
    expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
    allowedIps: body.allowedIps,
    createdBy: principal.sub,
  })

  await logAuditEvent({
    eventType: 'service_account.created',
    category: 'SERVICE_ACCOUNT',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'service_account',
    resourceId: id,
    action: 'create',
    source: 'iam-api',
  })

  return c.json({ id, apiKey, warning: 'Store this API key — it will not be shown again.' }, 201)
})

serviceAccountsRouter.get('/:id', requirePermission('iam:sa:read'), async (c) => {
  const sa = await prisma.serviceAccount.findUnique({
    where: { id: c.req.param('id') },
    include: { roles: { include: { role: true } }, client: { select: { name: true } } },
  })
  if (!sa) throw new ApiError(404, 'NOT_FOUND', 'Service account not found')
  return c.json({ serviceAccount: parseJsonFields({ ...sa, apiKeyHash: undefined }, 'allowedIps') })
})

serviceAccountsRouter.patch('/:id', requirePermission('iam:sa:write'), async (c) => {
  const principal = c.get('principal')
  const saId = c.req.param('id')
  const body = await parseBody(c, UpdateServiceAccountSchema)

  const data: Record<string, unknown> = {}
  if (body.description !== undefined) data['description'] = body.description
  if (body.active !== undefined) data['active'] = body.active
  if (body.expiresAt !== undefined) data['expiresAt'] = body.expiresAt ? new Date(body.expiresAt) : null
  if (body.allowedIps !== undefined) data['allowedIps'] = JSON.stringify(body.allowedIps)

  const sa = await prisma.serviceAccount.update({ where: { id: saId }, data })

  await logAuditEvent({
    eventType: 'service_account.updated',
    category: 'SERVICE_ACCOUNT',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'service_account',
    resourceId: saId,
    action: 'update',
    source: 'iam-api',
  })

  return c.json({ serviceAccount: parseJsonFields({ ...sa, apiKeyHash: undefined }, 'allowedIps') })
})

serviceAccountsRouter.delete('/:id', requirePermission('iam:sa:delete'), async (c) => {
  const principal = c.get('principal')
  const saId = c.req.param('id')

  const existing = await prisma.serviceAccount.findUnique({ where: { id: saId } })
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Service account not found')

  await logAuditEvent({
    eventType: 'service_account.deleted',
    category: 'SERVICE_ACCOUNT',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'service_account',
    resourceId: saId,
    action: 'delete',
    detail: { name: existing.name },
    source: 'iam-api',
  })

  await prisma.serviceAccount.delete({ where: { id: saId } })

  return c.json({ success: true })
})

serviceAccountsRouter.post('/:id/rotate', requirePermission('iam:sa:write'), async (c) => {
  const principal = c.get('principal')
  const saId = c.req.param('id')
  const apiKey = await rotateApiKey(saId)

  await logAuditEvent({
    eventType: 'service_account.key_rotated',
    category: 'SERVICE_ACCOUNT',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'service_account',
    resourceId: saId,
    action: 'rotate_key',
    source: 'iam-api',
  })

  return c.json({ apiKey, warning: 'New API key — store it safely, shown only once.' })
})
