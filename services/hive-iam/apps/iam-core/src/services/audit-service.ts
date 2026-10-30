import { auditQueue } from '../queue/audit-queue.js'
import type { AuditEventInput } from '../types/index.js'

let failures = 0
let lastFailure: string | null = null
let lastSuccess: string | null = null
export const auditEnqueueHealth = () => ({ failures, lastFailure, lastSuccess, degraded: Boolean(lastFailure && (!lastSuccess || lastFailure > lastSuccess)) })

/**
 * Enqueue an audit event for async persistence via BullMQ.
 * This is fire-and-forget from the request hot path.
 */
export async function logAuditEvent(event: AuditEventInput): Promise<void> {
  try {
    await auditQueue.add('audit', event)
    lastSuccess = new Date().toISOString()
  } catch (err) {
    failures++; lastFailure = new Date().toISOString()
    // Never let audit logging failures propagate to the caller
    console.error('[audit-service] Failed to enqueue event:', err)
  }
}
