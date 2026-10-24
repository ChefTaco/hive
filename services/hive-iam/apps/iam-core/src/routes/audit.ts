import { Hono } from 'hono'
import { streamText } from 'hono/streaming'
import { timingSafeEqual } from 'node:crypto'
import type { AuditEvent } from '../db/generated/index.js'
import { prisma } from '../db/client.js'
import { authMiddleware } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'
import { logAuditEvent } from '../services/audit-service.js'
import { env } from '../config/env.js'
import { z } from 'zod'

import type { AuditCategory, ActorType, AuditOutcome } from '../types/index.js'

export const auditRouter = new Hono()

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

const AUDIT_CATEGORIES: [AuditCategory, ...AuditCategory[]] = [
  'AUTHENTICATION', 'AUTHORIZATION', 'USER_MANAGEMENT', 'ROLE_MANAGEMENT',
  'SERVICE_ACCOUNT', 'SYSTEM_ACCESS', 'TOKEN', 'ADMIN', 'SUDO', 'AGENT',
]
const ACTOR_TYPES: [string, ...string[]] = ['USER', 'SERVICE_ACCOUNT', 'SYSTEM', 'AGENT']
const OUTCOMES: [AuditOutcome, ...AuditOutcome[]] = ['SUCCESS', 'FAILURE', 'DENIED']

const IngestEventSchema = z.object({
  eventType: z.string().min(1),
  category: z.enum(AUDIT_CATEGORIES),
  action: z.string().min(1),
  actorType: z.enum(ACTOR_TYPES as [ActorType, ...ActorType[]]).optional(),
  actorId: z.string().optional(),
  actorEmail: z.string().optional(),
  actorLabel: z.string().optional(),
  outcome: z.enum(OUTCOMES).optional(),
  ipAddress: z.string().optional(),
  hostName: z.string().optional(),
  resourceType: z.string().optional(),
  resourceId: z.string().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
  source: z.string().optional(),
  targetType: z.string().optional(),
  targetId: z.string().optional(),
})

const QuerySchema = z.object({
  page: z.coerce.number().default(1),
  limit: z.coerce.number().max(200).default(50),
  category: z.string().optional(),
  actorId: z.string().optional(),
  outcome: z.string().optional(),
  eventType: z.string().optional(),
  hostName: z.string().optional(),
  source: z.string().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
})

auditRouter.get('/', authMiddleware, requirePermission('iam:audit:read'), async (c) => {
  const params = QuerySchema.parse(c.req.query())
  const skip = (params.page - 1) * params.limit

  const where = {
    ...(params.category ? { category: params.category as never } : {}),
    ...(params.actorId ? { actorId: params.actorId } : {}),
    ...(params.outcome ? { outcome: params.outcome as never } : {}),
    ...(params.eventType ? { eventType: { contains: params.eventType } } : {}),
    ...(params.hostName ? { hostName: params.hostName } : {}),
    ...(params.source ? { source: params.source } : {}),
    ...(params.from || params.to
      ? {
          timestamp: {
            ...(params.from ? { gte: new Date(params.from) } : {}),
            ...(params.to ? { lte: new Date(params.to) } : {}),
          },
        }
      : {}),
  }

  const [events, total] = await Promise.all([
    prisma.auditEvent.findMany({
      where,
      skip,
      take: params.limit,
      orderBy: { timestamp: 'desc' },
    }),
    prisma.auditEvent.count({ where }),
  ])

  return c.json({ events: events.map((e) => ({ ...e, detail: typeof e.detail === 'string' ? JSON.parse(e.detail) : e.detail })), total, page: params.page, limit: params.limit })
})

// GET /audit/stats
auditRouter.get('/stats', authMiddleware, requirePermission('iam:audit:read'), async (c) => {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // last 30 days

  const [totalEvents, failureCount, deniedCount, successCount, byCategoryRaw] = await Promise.all([
    prisma.auditEvent.count({ where: { timestamp: { gte: since } } }),
    prisma.auditEvent.count({ where: { outcome: 'FAILURE', timestamp: { gte: since } } }),
    prisma.auditEvent.count({ where: { outcome: 'DENIED', timestamp: { gte: since } } }),
    prisma.auditEvent.count({ where: { outcome: 'SUCCESS', timestamp: { gte: since } } }),
    prisma.auditEvent.groupBy({
      by: ['category'],
      _count: { id: true },
      where: { timestamp: { gte: since } },
    }),
  ])

  const byCategory: Record<string, number> = {}
  for (const row of byCategoryRaw) {
    byCategory[row.category] = row._count.id
  }

  return c.json({ totalEvents, successCount, failureCount, deniedCount, byCategory })
})

// GET /audit/export — Export audit events as CSV, JSON, or syslog CEF format
auditRouter.get('/export', authMiddleware, requirePermission('iam:audit:read'), async (c) => {
  const format = (c.req.query('format') ?? 'csv') as 'csv' | 'json' | 'syslog'
  const from = c.req.query('from')
  const to = c.req.query('to')
  const category = c.req.query('category')
  const outcome = c.req.query('outcome')

  const where: Record<string, unknown> = {}
  if (category) where['category'] = category
  if (outcome) where['outcome'] = outcome
  if (from || to) {
    where['timestamp'] = {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lte: new Date(to) } : {}),
    }
  }

  const events = await prisma.auditEvent.findMany({
    where,
    orderBy: { timestamp: 'desc' },
    take: 50000,
  })

  const dateStr = new Date().toISOString().slice(0, 10)

  if (format === 'json') {
    c.header('Content-Type', 'application/json')
    c.header('Content-Disposition', `attachment; filename="iam-audit-${dateStr}.json"`)
    return c.json({
      events: events.map((e) => ({
        ...e,
        detail: typeof e.detail === 'string' ? JSON.parse(e.detail) : e.detail,
      })),
      meta: { total: events.length, exportedAt: new Date().toISOString() },
    })
  }

  if (format === 'syslog') {
    // Common Event Format (CEF) for SIEM ingestion
    c.header('Content-Type', 'text/plain; charset=utf-8')
    c.header('Content-Disposition', `attachment; filename="iam-audit-${dateStr}.cef"`)
    const cefLines = events.map((e) => {
      const severity = e.outcome === 'FAILURE' ? 7 : e.outcome === 'DENIED' ? 8 : 3
      const ext = [
        `src=${e.ipAddress ?? 'unknown'}`,
        `suser=${e.actorEmail ?? e.actorId ?? 'unknown'}`,
        `cat=${e.category}`,
        `outcome=${e.outcome ?? 'UNKNOWN'}`,
        e.hostName ? `dhost=${e.hostName}` : '',
        e.resourceType ? `cs1=${e.resourceType}` : '',
        e.resourceId ? `cs2=${e.resourceId}` : '',
      ].filter(Boolean).join(' ')
      return `CEF:0|Hive|IAM|1.0|${e.eventType}|${e.action}|${severity}|${ext}`
    })
    return c.text(cefLines.join('\n'))
  }

  // CSV format (default)
  c.header('Content-Type', 'text/csv; charset=utf-8')
  c.header('Content-Disposition', `attachment; filename="iam-audit-${dateStr}.csv"`)

  const csvHeader = 'timestamp,eventType,category,action,outcome,actorType,actorId,actorEmail,ipAddress,hostName,resourceType,resourceId,source\n'
  const csvRows = events.map((e) => {
    return [
      e.timestamp.toISOString(),
      e.eventType,
      e.category,
      e.action,
      e.outcome ?? '',
      e.actorType ?? '',
      e.actorId ?? '',
      e.actorEmail ?? '',
      e.ipAddress ?? '',
      e.hostName ?? '',
      e.resourceType ?? '',
      e.resourceId ?? '',
      e.source ?? '',
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')
  })

  return c.text(csvHeader + csvRows.join('\n'))
})

// GET /audit/stream — SSE live tail (polling from the DB, no BullMQ pub/sub needed)
auditRouter.get('/stream', authMiddleware, requirePermission('iam:audit:read'), async (c) => {
  return streamText(c, async (stream) => {
    let lastTimestamp: Date | null = null
    let alive = true

    // Send initial keepalive
    await stream.write(': keepalive\n\n')

    const heartbeat = setInterval(async () => {
      try {
        await stream.write(': keepalive\n\n')
      } catch {
        alive = false
      }
    }, 30_000)

    while (alive) {
      await new Promise((r) => setTimeout(r, 2000))

      const events: AuditEvent[] = await prisma.auditEvent.findMany({
        ...(lastTimestamp ? { where: { timestamp: { gt: lastTimestamp } } } : {}),
        orderBy: { timestamp: 'asc' },
        take: 20,
      })

      for (const evt of events) {
        lastTimestamp = evt.timestamp
        try {
          await stream.write(`data: ${JSON.stringify(evt)}\n\n`)
        } catch {
          alive = false
          break
        }
      }
    }

    clearInterval(heartbeat)
  })
})

// POST /audit/ingest — called by IAM agent to ship system events
auditRouter.post('/ingest', async (c) => {
  const agentToken = c.req.header('x-agent-token')
  if (!agentToken || !constantTimeEqual(agentToken, env.IAM_AGENT_SECRET)) {
    return c.json({ error: 'UNAUTHORIZED' }, 401)
  }

  let rawEvents: unknown[]
  try {
    rawEvents = await c.req.json()
    if (!Array.isArray(rawEvents)) throw new Error('Expected array')
  } catch {
    return c.json({ error: 'VALIDATION_ERROR', message: 'Body must be a JSON array' }, 400)
  }

  let ingested = 0
  for (const raw of rawEvents) {
    const parsed = IngestEventSchema.safeParse(raw)
    if (parsed.success) {
      await logAuditEvent(parsed.data)
      ingested++
    }
  }

  return c.json({ ingested })
})
