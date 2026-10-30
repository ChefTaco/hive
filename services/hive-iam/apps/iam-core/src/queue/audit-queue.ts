import { Queue } from 'bullmq'
import { Redis } from 'ioredis'
import { env } from '../config/env.js'
import type { AuditEventInput } from '../types/index.js'

export const redisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
})

export const auditQueue = new Queue<AuditEventInput, unknown, 'audit'>('audit-events', {
  connection: redisConnection.duplicate({ enableOfflineQueue: false, maxRetriesPerRequest: 1, commandTimeout: 1500 }) as never,
  prefix: env.REDIS_PREFIX,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 50,
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
  },
})
