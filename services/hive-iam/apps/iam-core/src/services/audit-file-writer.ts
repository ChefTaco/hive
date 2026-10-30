import { mkdir, appendFile, readdir, unlink, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { env } from '../config/env.js'
import type { AuditEventInput } from '../types/index.js'

const DEFAULT_AUDIT_DIR = resolve(import.meta.dirname, '../../audit-logs')

function getAuditDir(): string {
  return env.AUDIT_LOG_DIR ?? DEFAULT_AUDIT_DIR
}

function dateToKey(d: Date): string {
  return d.toISOString().slice(0, 10) // YYYY-MM-DD
}

function logFilePath(dayKey: string): string {
  return join(getAuditDir(), `${dayKey}.jsonl`)
}

/**
 * Append an audit event to the daily JSONL file.
 * One file per day, e.g. audit-logs/2026-02-27.jsonl
 */
export async function writeAuditToFile(event: AuditEventInput & { id?: string }): Promise<void> {
  const now = new Date()
  const entry = {
    id: event.id ?? crypto.randomUUID(),
    timestamp: now.toISOString(),
    eventType: event.eventType,
    category: event.category,
    action: event.action,
    actorId: event.actorId ?? null,
    actorType: event.actorType ?? 'USER',
    actorEmail: event.actorEmail ?? null,
    clientId: event.clientId ?? null,
    serviceAccountId: event.serviceAccountId ?? null,
    ipAddress: event.ipAddress ?? null,
    userAgent: event.userAgent ?? null,
    resourceType: event.resourceType ?? null,
    resourceId: event.resourceId ?? null,
    outcome: event.outcome ?? 'SUCCESS',
    detail: event.detail ?? {},
    source: event.source ?? 'iam-api',
    hostName: event.hostName ?? null,
  }

  const dir = getAuditDir()
  await mkdir(dir, { recursive: true })
  await appendFile(logFilePath(dateToKey(now)), JSON.stringify(entry) + '\n', 'utf-8')
}

/**
 * Delete audit log files older than maxAgeDays.
 * Called periodically from the retention timer.
 */
export async function pruneOldAuditFiles(): Promise<number> {
  const maxAgeDays = env.AUDIT_MAX_AGE_DAYS
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000)
  const cutoffKey = dateToKey(cutoff)
  const dir = getAuditDir()

  let deleted = 0
  try {
    const files = await readdir(dir)
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const dayKey = file.replace('.jsonl', '')
      if (dayKey < cutoffKey) {
        await unlink(join(dir, file))
        deleted++
      }
    }
  } catch (err) {
    // Directory may not exist yet — that's fine
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[audit-retention] Error pruning files:', err)
    }
  }

  return deleted
}

let retentionTimer: ReturnType<typeof setInterval> | null = null
let lastPrunedDate: string | null = null

/**
 * Start the daily audit file retention check.
 * Runs once per hour but only prunes once per day.
 */
export function startAuditRetention(): void {
  if (retentionTimer) return

  const CHECK_INTERVAL_MS = 3_600_000 // 1 hour

  const runPrune = async () => {
    const today = dateToKey(new Date())
    if (lastPrunedDate === today) return

    const deleted = await pruneOldAuditFiles()
    lastPrunedDate = today
    if (deleted > 0) {
      console.log(`[audit-retention] Pruned ${deleted} file(s) older than ${env.AUDIT_MAX_AGE_DAYS} days`)
    }
  }

  void runPrune()
  retentionTimer = setInterval(() => void runPrune(), CHECK_INTERVAL_MS)
}

export function stopAuditRetention(): void {
  if (retentionTimer) {
    clearInterval(retentionTimer)
    retentionTimer = null
  }
}
