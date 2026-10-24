import 'dotenv/config'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'node:https'
import { serve } from '@hono/node-server'
import { createApp } from './server.js'
import { env } from './config/env.js'
import { startAuditWorker } from './queue/audit-worker.js'
import { startAuditRetention, stopAuditRetention } from './services/audit-file-writer.js'
import { IAM_VERSION } from './config/version.js'

async function main() {
  console.log(`Hive IAM Core v${IAM_VERSION} — starting...`)

  // Start BullMQ audit worker
  const worker = startAuditWorker()
  console.log('  ✓ Audit worker started')

  // Start audit file retention (prunes files older than AUDIT_MAX_AGE_DAYS)
  startAuditRetention()
  console.log(`  ✓ Audit retention started (max age: ${env.AUDIT_MAX_AGE_DAYS} days)`)

  const app = createApp()

  // TLS config (optional — use a reverse proxy in production)
  const certPath = env.TLS_CERT_PATH ? resolve(env.TLS_CERT_PATH) : undefined
  const keyPath = env.TLS_KEY_PATH ? resolve(env.TLS_KEY_PATH) : undefined
  const useTls = certPath && keyPath && existsSync(certPath) && existsSync(keyPath)

  if (useTls) {
    console.log('  ✓ TLS certificates loaded')
  }

  const server = serve(
    {
      fetch: app.fetch,
      port: env.PORT,
      hostname: env.HOST,
      ...(useTls
        ? {
            createServer,
            serverOptions: {
              key: readFileSync(keyPath),
              cert: readFileSync(certPath),
            },
          }
        : {}),
    },
    (info) => {
      const protocol = useTls ? 'https' : 'http'
      console.log(`  ✓ Listening on ${protocol}://${env.HOST}:${info.port}`)
      console.log(`  ✓ Public key: ${protocol}://${env.HOST}:${info.port}/api/v1/auth/public-key`)
    },
  )

  const shutdown = async () => {
    console.log('\nShutting down...')
    stopAuditRetention()
    await worker.close()
    server.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('Fatal startup error:', err)
  process.exit(1)
})
