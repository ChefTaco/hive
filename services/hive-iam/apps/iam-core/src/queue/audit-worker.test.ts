import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/client.js', () => ({ prisma: {} }))
vi.mock('./audit-queue.js', () => ({ redisConnection: {} }))
vi.mock('../config/env.js', () => ({ env: { REDIS_PREFIX: 'test' } }))
vi.mock('../services/audit-file-writer.js', () => ({ writeAuditToFile: vi.fn() }))

const { auditEventRecord } = await import('./audit-worker.js')

const lookup = (known: string[]) => {
  const has = async (id: string) => known.includes(id)
  return { userExists: has, clientExists: has, serviceAccountExists: has }
}

describe('auditEventRecord', () => {
  it('links actor, client and service account IDs that exist', async () => {
    const record = await auditEventRecord({
      eventType: 'LOGIN',
      category: 'AUTHENTICATION',
      action: 'login',
      actorId: 'user-1',
      clientId: 'hive-router',
      serviceAccountId: 'sa-1',
      detail: { method: 'password' },
    }, lookup(['user-1', 'hive-router', 'sa-1']))

    expect(record).toMatchObject({ actorId: 'user-1', clientId: 'hive-router', serviceAccountId: 'sa-1' })
    expect(JSON.parse(record.detail)).toEqual({ method: 'password' })
  })

  it('keeps unknown IDs in detail instead of violating foreign keys', async () => {
    const record = await auditEventRecord({
      eventType: 'TOKEN_ISSUED',
      category: 'AUTHENTICATION',
      action: 'client_credentials',
      actorId: 'machine-client',
      actorType: 'SERVICE_ACCOUNT',
      clientId: 'deleted-client',
      detail: { scope: 'iam:audit:read' },
    }, lookup([]))

    expect(record.actorId).toBeUndefined()
    expect(record.clientId).toBeUndefined()
    expect(record.actorType).toBe('SERVICE_ACCOUNT')
    expect(JSON.parse(record.detail)).toEqual({
      scope: 'iam:audit:read',
      unlinked: { actorId: 'machine-client', clientId: 'deleted-client' },
    })
  })
})
