import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth.js'
import { logAuditEvent } from '../services/audit-service.js'
import { getClientIp } from '../utils/ip.js'
import {
  computeDeviceFingerprint,
  listTrustedDevices,
  registerTrustedDevice,
  revokeTrustedDevice,
  deleteTrustedDevice,
  assessDevicePosture,
} from '../services/device-trust-service.js'

export const devicesRouter = new Hono()

devicesRouter.use('*', authMiddleware)

/**
 * GET /devices
 * List the current user's trusted devices.
 */
devicesRouter.get('/', async (c) => {
  const principal = c.get('principal')
  const devices = await listTrustedDevices(principal.sub)
  return c.json({ success: true, data: devices })
})

/**
 * POST /devices/trust
 * Register the current device as trusted.
 */
devicesRouter.post('/trust', async (c) => {
  const principal = c.get('principal')
  const ip = getClientIp(c)
  const userAgent = c.req.header('user-agent')
  const acceptLanguage = c.req.header('accept-language')
  const body = await c.req.json().catch(() => ({})) as { name?: string }

  const fingerprint = computeDeviceFingerprint(userAgent, acceptLanguage)
  const result = await registerTrustedDevice(principal.sub, fingerprint, {
    name: body.name,
    userAgent,
    ipAddress: ip,
  })

  await logAuditEvent({
    eventType: 'device.trust',
    category: 'AUTHENTICATION',
    actorId: principal.sub,
    actorType: 'USER',
    actorEmail: principal.email,
    ipAddress: ip,
    action: result.isNew ? 'device_trusted' : 'device_seen',
    outcome: 'SUCCESS',
    source: 'iam-api',
  })

  return c.json({ success: true, data: { ...result, fingerprint } })
})

/**
 * POST /devices/:id/revoke
 * Revoke trust for a specific device.
 */
devicesRouter.post('/:id/revoke', async (c) => {
  const principal = c.get('principal')
  const deviceId = c.req.param('id')
  const ip = getClientIp(c)

  const revoked = await revokeTrustedDevice(principal.sub, deviceId)
  if (!revoked) return c.json({ error: 'NOT_FOUND', message: 'Device not found' }, 404)

  await logAuditEvent({
    eventType: 'device.revoke',
    category: 'AUTHENTICATION',
    actorId: principal.sub,
    actorType: 'USER',
    actorEmail: principal.email,
    ipAddress: ip,
    action: 'device_revoked',
    outcome: 'SUCCESS',
    source: 'iam-api',
  })

  return c.json({ success: true })
})

/**
 * DELETE /devices/:id
 * Delete a trusted device.
 */
devicesRouter.delete('/:id', async (c) => {
  const principal = c.get('principal')
  const deviceId = c.req.param('id')
  const ip = getClientIp(c)

  const deleted = await deleteTrustedDevice(principal.sub, deviceId)
  if (!deleted) return c.json({ error: 'NOT_FOUND', message: 'Device not found' }, 404)

  await logAuditEvent({
    eventType: 'device.delete',
    category: 'AUTHENTICATION',
    actorId: principal.sub,
    actorType: 'USER',
    actorEmail: principal.email,
    ipAddress: ip,
    action: 'device_deleted',
    outcome: 'SUCCESS',
    source: 'iam-api',
  })

  return c.json({ success: true })
})

/**
 * GET /devices/posture
 * Assess the posture of the current device.
 */
devicesRouter.get('/posture', async (c) => {
  const principal = c.get('principal')
  const userAgent = c.req.header('user-agent')
  const acceptLanguage = c.req.header('accept-language')
  const ip = getClientIp(c)

  const fingerprint = computeDeviceFingerprint(userAgent, acceptLanguage)
  const posture = await assessDevicePosture(principal.sub, fingerprint, {
    ipAddress: ip,
    userAgent,
  })

  return c.json({ success: true, data: { fingerprint, ...posture } })
})
