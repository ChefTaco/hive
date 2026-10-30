import type { MiddlewareHandler } from 'hono'
import { redisConnection } from '../queue/audit-queue.js'
import { env } from '../config/env.js'
import { getClientIp } from '../utils/ip.js'

/**
 * Sliding-window rate limiter backed by Redis.
 * Keyed by IP address.
 */
export function rateLimitMiddleware(
  opts: { windowMs?: number; max?: number; keyPrefix?: string } = {},
): MiddlewareHandler {
  const windowMs = opts.windowMs ?? env.RATE_LIMIT_WINDOW_MS
  const max = opts.max ?? env.RATE_LIMIT_MAX_ATTEMPTS
  const prefix = opts.keyPrefix ?? 'rl'

  return async (c, next) => {
    const ip = getClientIp(c)
    const key = `${env.REDIS_PREFIX}:${prefix}:${ip}`
    const now = Date.now()
    const windowStart = now - windowMs

    const pipe = redisConnection.pipeline()
    pipe.zremrangebyscore(key, '-inf', windowStart)
    pipe.zadd(key, now, `${now}-${Math.random()}`)
    pipe.zcard(key)
    pipe.pexpire(key, windowMs)
    const results = await pipe.exec()

    const count = (results?.[2]?.[1] as number) ?? 0

    if (count > max) {
      const retryAfter = Math.ceil(windowMs / 1000)
      c.header('Retry-After', String(retryAfter))
      return c.json(
        { error: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' },
        429,
      )
    }

    return next()
  }
}
