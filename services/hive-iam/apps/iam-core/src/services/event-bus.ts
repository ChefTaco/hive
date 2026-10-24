/**
 * Redis-backed event bus for real-time inter-service communication.
 *
 * Uses Redis Pub/Sub to broadcast IAM events (auth, user, session, audit)
 * to subscribers. Enables SSE endpoints and cross-service notifications.
 */

import { Redis } from 'ioredis'
import { EventEmitter } from 'node:events'

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379'
const CHANNEL_PREFIX = 'hive-iam:events:'

type EventHandler = (channel: string, data: unknown) => void

class EventBus {
  private publisher: Redis | null = null
  private subscriber: Redis | null = null
  private localEmitter = new EventEmitter()
  private connected = false
  private patterns = new Set<string>()

  constructor() {
    this.localEmitter.setMaxListeners(100)
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return

    try {
      this.publisher = new Redis(REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true })
      this.subscriber = new Redis(REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true })

      await Promise.all([
        this.publisher.connect(),
        this.subscriber.connect(),
      ])

      this.subscriber.on('pmessage', (_pattern, channel, message) => {
        const shortChannel = channel.replace(CHANNEL_PREFIX, '')
        try {
          const data = JSON.parse(message)
          this.localEmitter.emit(shortChannel, shortChannel, data)
          this.localEmitter.emit('*', shortChannel, data)
        } catch {
          this.localEmitter.emit(shortChannel, shortChannel, message)
        }
      })

      for (const pattern of this.patterns) {
        await this.subscriber.psubscribe(`${CHANNEL_PREFIX}${pattern}`)
      }

      this.connected = true
    } catch {
      this.connected = false
    }
  }

  async publish(channel: string, data: unknown): Promise<void> {
    const fullChannel = `${CHANNEL_PREFIX}${channel}`
    const payload = JSON.stringify(data)

    try {
      await this.ensureConnected()
      if (this.publisher) {
        await this.publisher.publish(fullChannel, payload)
      }
    } catch {
      // Fall back to local emitter only
    }

    this.localEmitter.emit(channel, channel, data)
    this.localEmitter.emit('*', channel, data)
  }

  async subscribe(pattern: string, handler: EventHandler): Promise<() => void> {
    this.patterns.add(pattern)

    try {
      await this.ensureConnected()
      if (this.subscriber) {
        await this.subscriber.psubscribe(`${CHANNEL_PREFIX}${pattern}`)
      }
    } catch {
      // Local-only mode
    }

    const wrappedHandler = (ch: string, data: unknown) => {
      handler(ch, data)
    }

    if (pattern === '*') {
      this.localEmitter.on('*', wrappedHandler)
    } else {
      this.localEmitter.on(pattern, wrappedHandler)
    }

    return () => {
      this.localEmitter.off(pattern === '*' ? '*' : pattern, wrappedHandler)
    }
  }

  async close(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.punsubscribe()
      this.subscriber.disconnect()
    }
    if (this.publisher) {
      this.publisher.disconnect()
    }
    this.localEmitter.removeAllListeners()
    this.connected = false
  }
}

export const eventBus = new EventBus()

export const EventChannels = {
  AUTH_LOGIN: 'auth:login',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_MFA: 'auth:mfa',
  USER_CREATED: 'user:created',
  USER_UPDATED: 'user:updated',
  USER_DELETED: 'user:deleted',
  SESSION_CREATED: 'session:created',
  SESSION_REVOKED: 'session:revoked',
  GROUP_UPDATED: 'group:updated',
  AUDIT_EVENT: 'audit:event',
  PASSWORD_RESET: 'password:reset',
} as const
