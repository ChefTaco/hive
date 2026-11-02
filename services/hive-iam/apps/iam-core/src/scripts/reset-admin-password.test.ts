import { afterEach, describe, expect, it, vi } from 'vitest'

const database = vi.hoisted(() => ({
  role: { findUnique: vi.fn() },
  user: { findFirst: vi.fn(), update: vi.fn() },
  userRoleAssignment: { upsert: vi.fn() },
  $disconnect: vi.fn(),
}))
vi.mock('argon2', () => ({ argon2id: 2, hash: vi.fn().mockResolvedValue('synthetic-argon2id-hash') }))
vi.mock('@prisma/adapter-better-sqlite3', () => ({ PrismaBetterSqlite3: class {} }))
vi.mock('../db/generated/index.js', () => ({ PrismaClient: class { constructor() { return database } } }))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('administrator reset output privacy', () => {
  for (const failure of [false, true]) it(failure ? 'does not print database errors containing credentials' : 'does not print account identifiers or credentials on success', async () => {
    vi.stubEnv('IAM_RESET_USERNAME', 'synthetic-private-admin')
    vi.stubEnv('IAM_RESET_EMAIL', 'private-admin@example.com')
    vi.stubEnv('IAM_RESET_PASSWORD', 'Synthetic-Reset-Password-42!')
    database.role.findUnique.mockResolvedValue({ id: 'synthetic-role' })
    database.user.findFirst.mockResolvedValue({ id: 'synthetic-user', displayName: 'Administrator' })
    database.user.update.mockImplementation(async () => {
      if (failure) throw new Error('Synthetic-Reset-Password-42! private-admin@example.com')
      return { id: 'synthetic-user' }
    })
    database.userRoleAssignment.upsert.mockResolvedValue({})
    database.$disconnect.mockResolvedValue(undefined)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await import('./reset-admin-password.js')
    await vi.waitFor(() => expect(database.$disconnect).toHaveBeenCalledOnce())
    const output = JSON.stringify([...log.mock.calls, ...error.mock.calls])
    for (const secret of ['synthetic-private-admin', 'private-admin@example.com', 'Synthetic-Reset-Password-42!']) expect(output).not.toContain(secret)
    if (failure) expect(exit).toHaveBeenCalledWith(1)
    else expect(log).toHaveBeenCalledWith('IAM admin password reset completed.')
  })
})
