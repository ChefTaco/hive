import { once } from 'node:events'
import { connect, type AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { describe, expect, it } from 'vitest'

describe('HTTP dependency security regressions', () => {
  it('rejects a cross-origin text/ping POST before a state change', async () => {
    let changes = 0
    const app = new Hono().use(csrf()).post('/operation', c => {
      changes++
      return c.text('updated')
    })
    const response = await app.request('https://identity.example.com/operation', {
      method: 'POST',
      headers: { Origin: 'https://untrusted.example.com', 'Content-Type': 'text/ping', 'Sec-Fetch-Site': 'cross-site' },
      body: 'PING',
    })
    expect(response.status).toBe(403)
    expect(changes).toBe(0)
    const allowed = await app.request('https://identity.example.com/operation', {
      method: 'POST',
      headers: { Origin: 'https://identity.example.com', 'Content-Type': 'text/ping', 'Sec-Fetch-Site': 'same-origin' },
      body: 'PING',
    })
    expect(allowed.status).toBe(200)
    expect(changes).toBe(1)
  })

  it('rejects a raw backslash before it can be normalized into a protected route', async () => {
    let protectedHits = 0
    const app = new Hono().get('/private', c => {
      protectedHits++
      return c.text('private')
    })
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
    try {
      if (!server.listening) await once(server, 'listening')
      const port = (server.address() as AddressInfo).port
      const response = await new Promise<string>((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port })
        let data = ''
        socket.setTimeout(3000, () => socket.destroy(new Error('HTTP regression probe timed out')))
        socket.setEncoding('utf8')
        socket.on('data', chunk => { data += chunk })
        socket.on('error', reject)
        socket.on('end', () => resolve(data))
        socket.on('connect', () => socket.write('GET /public\\..\\private HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'))
      })
      expect(response).toMatch(/^HTTP\/1\.1 400 /)
      expect(protectedHits).toBe(0)
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
})
