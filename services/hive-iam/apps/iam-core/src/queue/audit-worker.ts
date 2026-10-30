import { Worker } from 'bullmq'
import { prisma } from '../db/client.js'
import { redisConnection } from './audit-queue.js'
import { env } from '../config/env.js'
import { writeAuditToFile } from '../services/audit-file-writer.js'
import type { AuditEventInput } from '../types/index.js'

export interface AuditRelationLookup {
  userExists(id: string): Promise<boolean>
  clientExists(id: string): Promise<boolean>
  serviceAccountExists(id: string): Promise<boolean>
}

const prismaLookup: AuditRelationLookup = {
  userExists: async (id) => (await prisma.user.count({ where: { id } })) > 0,
  clientExists: async (id) => (await prisma.client.count({ where: { id } })) > 0,
  serviceAccountExists: async (id) => (await prisma.serviceAccount.count({ where: { id } })) > 0,
}

/**
 * Builds the SQLite audit row. Actor, client and service-account IDs are foreign keys,
 * but events can reference actors that are not rows in those tables (machine clients
 * acting as actors, deleted users). Unmatched IDs are kept in `detail` instead of
 * failing the insert.
 */
export async function auditEventRecord(data: AuditEventInput, lookup: AuditRelationLookup = prismaLookup) {
  const unlinked: Record<string, string> = {}
  const link = async (id: string | undefined, key: string, exists: (id: string) => Promise<boolean>) => {
    if (!id) return undefined
    if (await exists(id)) return id
    unlinked[key] = id
    return undefined
  }
  const [actorId, clientId, serviceAccountId] = await Promise.all([
    link(data.actorId, 'actorId', lookup.userExists),
    link(data.clientId, 'clientId', lookup.clientExists),
    link(data.serviceAccountId, 'serviceAccountId', lookup.serviceAccountExists),
  ])
  const detail = Object.keys(unlinked).length > 0
    ? { ...(data.detail ?? {}), unlinked }
    : (data.detail ?? {})
  return {
    eventType: data.eventType,
    category: data.category,
    actorId,
    actorType: data.actorType ?? 'USER',
    actorEmail: data.actorEmail,
    clientId,
    serviceAccountId,
    ipAddress: data.ipAddress,
    userAgent: data.userAgent,
    resourceType: data.resourceType,
    resourceId: data.resourceId,
    action: data.action,
    outcome: data.outcome ?? 'SUCCESS',
    detail: JSON.stringify(detail),
    source: data.source ?? 'iam-api',
    hostName: data.hostName,
  }
}

export function startAuditWorker(): Worker<AuditEventInput> {
  const worker = new Worker<AuditEventInput>(
    'audit-events',
    async (job) => {
      const data = job.data

      // Write to daily JSONL file (primary log store)
      await writeAuditToFile(data)

      // Also persist to SQLite for querying via API
      await prisma.auditEvent.create({ data: await auditEventRecord(data) })
    },
    {
      connection: redisConnection as never,
      prefix: env.REDIS_PREFIX,
      concurrency: 10,
    },
  )

  worker.on('failed', (job, err) => {
    console.error(`[audit-worker] Job ${job?.id} failed:`, err.message)
  })

  return worker
}
