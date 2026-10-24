import { Worker } from 'bullmq'
import { prisma } from '../db/client.js'
import { redisConnection } from './audit-queue.js'
import { env } from '../config/env.js'
import { writeAuditToFile } from '../services/audit-file-writer.js'
import type { AuditEventInput } from '../types/index.js'

export function startAuditWorker(): Worker<AuditEventInput> {
  const worker = new Worker<AuditEventInput>(
    'audit-events',
    async (job) => {
      const data = job.data

      // Write to daily JSONL file (primary log store)
      await writeAuditToFile(data)

      // Also persist to SQLite for querying via API
      await prisma.auditEvent.create({
        data: {
          eventType: data.eventType,
          category: data.category,
          actorId: data.actorId,
          actorType: data.actorType ?? 'USER',
          actorEmail: data.actorEmail,
          clientId: data.clientId,
          serviceAccountId: data.serviceAccountId,
          ipAddress: data.ipAddress,
          userAgent: data.userAgent,
          resourceType: data.resourceType,
          resourceId: data.resourceId,
          action: data.action,
          outcome: data.outcome ?? 'SUCCESS',
          detail: JSON.stringify(data.detail ?? {}),
          source: data.source ?? 'iam-api',
          hostName: data.hostName,
        },
      })
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
