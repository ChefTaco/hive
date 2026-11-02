import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkBreachedPassword } from './breach-check-service.js'

afterEach(() => vi.unstubAllGlobals())

describe('Pwned Passwords lookup protocol', () => {
  it('sends only the five-character SHA-1 prefix, never the password or full digest', async () => {
    // Public synthetic vector: SHA-1("password"). This digest is never stored as a credential.
    const digest = '5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8'
    const fetchMock = vi.fn().mockResolvedValue(new Response(`${digest.slice(5)}:42\r\n${'0'.repeat(35)}:1\r\n`))
    vi.stubGlobal('fetch', fetchMock)
    expect(await checkBreachedPassword('password')).toBe(42)
    const [url, options] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.pwnedpasswords.com/range/5BAA6')
    expect(options.body).toBeUndefined()
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(digest)
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('"password"')
  })

  it('distinguishes a missing match from an unavailable breach service', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(`${'0'.repeat(35)}:1`))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockRejectedValueOnce(new Error('Synthetic network failure'))
    vi.stubGlobal('fetch', fetchMock)
    expect(await checkBreachedPassword('synthetic-password')).toBe(0)
    expect(await checkBreachedPassword('synthetic-password')).toBe(-1)
    expect(await checkBreachedPassword('synthetic-password')).toBe(-1)
  })
})
