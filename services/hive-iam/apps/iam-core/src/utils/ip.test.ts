import { describe, it, expect, vi } from 'vitest'
import { getClientIp, resolveClientIp } from './ip.js'

function mockContext(headers: Record<string, string | undefined> = {}) {
  return {
    req: {
      header(name: string) {
        return headers[name.toLowerCase()]
      },
    },
  } as Parameters<typeof getClientIp>[0]
}

describe('getClientIp', () => {
  it('ignores proxy headers when the socket peer is not trusted', () => {
    expect(resolveClientIp({ forwarded: '1.2.3.4' }, '203.0.113.10', ['127.0.0.1'])).toBe('203.0.113.10')
  })

  it('uses the first forwarded address from a trusted proxy', () => {
    expect(resolveClientIp({ forwarded: '1.2.3.4, 5.6.7.8', realIp: '2.2.2.2' }, '127.0.0.1', ['127.0.0.1'])).toBe('1.2.3.4')
  })

  it('returns unknown when neither a peer nor trusted headers are available', () => {
    const c = mockContext({})
    expect(getClientIp(c)).toBe('unknown')
  })

  it('trims whitespace from trusted forwarding headers', () => {
    expect(resolveClientIp({ forwarded: '  9.8.7.6 , 1.1.1.1' }, '127.0.0.1', ['127.0.0.1'])).toBe('9.8.7.6')
  })

  it('falls back to trusted x-real-ip when x-forwarded-for is absent', () => {
    expect(resolveClientIp({ realIp: '10.0.0.1' }, '127.0.0.1', ['127.0.0.1'])).toBe('10.0.0.1')
  })
})
