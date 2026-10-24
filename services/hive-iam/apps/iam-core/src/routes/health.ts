import { auditEnqueueHealth } from '../services/audit-service.js'
import { Hono } from 'hono'
import { prisma } from '../db/client.js'
import { redisConnection } from '../queue/audit-queue.js'
import { IAM_VERSION } from '../config/version.js'

import type { HealthCheck } from '../types/index.js'

export const healthRouter = new Hono()

const CHECK_TIMEOUT_MS = 1500

interface QueryableDatabase {
  $queryRawUnsafe(query: string): Promise<unknown>
}

interface PingableRedis {
  ping(): Promise<unknown>
}

interface IamHealthClients {
  database: QueryableDatabase
  redis: PingableRedis
}

export interface IamDependencyReport {
  status: 'healthy' | 'degraded'
  version: string
  uptime: number
  timestamp: string
  checks: HealthCheck[]
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('health check timed out')), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function roundedLatency(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100
}

async function timedDependencyCheck(
  name: string,
  operation: Promise<unknown>,
): Promise<HealthCheck> {
  const startedAt = performance.now()
  try {
    await withTimeout(operation, CHECK_TIMEOUT_MS)
    return {
      name,
      status: 'pass',
      latencyMs: roundedLatency(startedAt),
      message: 'connected',
    }
  } catch (error) {
    return {
      name,
      status: 'fail',
      latencyMs: roundedLatency(startedAt),
      message: error instanceof Error ? error.message : 'unreachable',
    }
  }
}

export async function buildIamDependencyReport(clients: IamHealthClients = { database: prisma, redis: redisConnection }): Promise<IamDependencyReport> {
  const checks = await Promise.all([
    timedDependencyCheck('database', clients.database.$queryRawUnsafe('SELECT 1')),
    timedDependencyCheck('redis', clients.redis.ping()),
  ])

  if (auditEnqueueHealth().degraded) checks.push({ name: 'audit-enqueue', status: 'fail', message: 'Audit events could not be queued; inspect IAM logs' })
  const allPass = checks.every((check) => check.status === 'pass')

  return {
    status: allPass ? 'healthy' : 'degraded',
    version: IAM_VERSION,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    checks,
  }
}

function statusCodeFor(report: IamDependencyReport): 200 | 503 {
  return report.status === 'healthy' ? 200 : 503
}

healthRouter.get('/', async (c) => {
  const report = await buildIamDependencyReport()
  return c.json(report, statusCodeFor(report))
})

healthRouter.get('/live', (c) => c.json({
  status: 'ok',
  version: IAM_VERSION,
  uptime: Math.floor(process.uptime()),
  timestamp: new Date().toISOString(),
  checks: [{ name: 'process', status: 'pass', message: 'running' }],
}))

healthRouter.get('/dependencies', async (c) => {
  const report = await buildIamDependencyReport()
  return c.json(report, statusCodeFor(report))
})

healthRouter.get('/ready', async (c) => {
  const report = await buildIamDependencyReport()
  return c.json(report, statusCodeFor(report))
})
