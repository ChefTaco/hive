import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/client.js', () => ({
  prisma: { $queryRawUnsafe: vi.fn(async () => 1) },
}))

vi.mock('../queue/audit-queue.js', () => ({
  redisConnection: { ping: vi.fn(async () => 'PONG') },
}))

const { healthRouter, buildIamDependencyReport } = await import('./health.js')

describe('IAM health routes', () => {
  it('builds a healthy dependency report', async () => {
    const report = await buildIamDependencyReport({
      database: { $queryRawUnsafe: async () => 1 },
      redis: { ping: async () => 'PONG' },
    })

    expect(report.status).toBe('healthy')
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'database', status: 'pass' }),
      expect.objectContaining({ name: 'redis', status: 'pass' }),
    ]))
  })

  it('degrades when a dependency fails', async () => {
    const report = await buildIamDependencyReport({
      database: { $queryRawUnsafe: async () => 1 },
      redis: { ping: async () => { throw new Error('redis unavailable') } },
    })

    expect(report.status).toBe('degraded')
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'redis', status: 'fail', message: 'redis unavailable' }),
    ]))
  })

  it('serves a dependency-free liveness response', async () => {
    const response = await healthRouter.request('/live')
    const body = await response.json() as { status: string; checks: Array<{ name: string; status: string }> }

    expect(response.status).toBe(200)
    expect(body.status).toBe('ok')
    expect(body.checks).toEqual([expect.objectContaining({ name: 'process', status: 'pass' })])
  })
})
