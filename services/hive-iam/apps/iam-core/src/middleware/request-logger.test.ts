import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../services/audit-service.js', () => ({
  logAuditEvent: vi.fn(),
}))

import { Hono } from 'hono'
import { accessLoggerMiddleware, requestLoggerMiddleware } from './request-logger.js'
import { logAuditEvent } from '../services/audit-service.js'

const mockedLogAuditEvent = vi.mocked(logAuditEvent)

function createApp() {
  const app = new Hono()
  app.use('/api/v1/*', requestLoggerMiddleware)
  app.get('/api/v1/users', (c) => c.json({ ok: true }))
  app.get('/api/v1/health', (c) => c.json({ status: 'ok' }))
  return app
}

describe('requestLoggerMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('records propagated Hive request IDs in audit details', async () => {
    const app = createApp()
    const response = await app.request('/api/v1/users', {
      headers: { 'x-hive-request-id': 'req-hive-123' },
    })

    expect(response.status).toBe(200)
    expect(mockedLogAuditEvent).toHaveBeenCalledTimes(1)
    expect(mockedLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'api.request',
      detail: expect.objectContaining({
        requestId: 'req-hive-123',
        method: 'GET',
        path: '/api/v1/users',
        status: 200,
      }),
    }))
  })

  it('skips health route audit noise', async () => {
    const app = createApp()
    const response = await app.request('/api/v1/health', {
      headers: { 'x-hive-request-id': 'req-health-123' },
    })

    expect(response.status).toBe(200)
    expect(mockedLogAuditEvent).not.toHaveBeenCalled()
  })

  it('logs access outcomes without OAuth parameters or request credentials', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const app = new Hono()
      app.use('*', accessLoggerMiddleware)
      app.get('/callback', (c) => c.json({ ok: true }))
      await app.request('/callback?code=dummy-code&state=dummy-state&token=dummy-token', {
        headers: { authorization: 'Bearer dummy-bearer', cookie: 'session=dummy-cookie' },
      })
      expect(log).toHaveBeenCalledTimes(1)
      expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ method: 'GET', path: '/callback', status: 200 })
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/dummy-|code=|state=|token=/)
    } finally {
      log.mockRestore()
    }
  })
})
