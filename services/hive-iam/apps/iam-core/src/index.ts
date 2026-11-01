// Production entry point (systemd runs `node dist/index.js` from the install
// directory). The `hive-iam-server` CLI lives in cli.ts.
import 'dotenv/config'
import { productionMigrations } from './startup-migrations.js'

productionMigrations().then(async () => { const { startServer } = await import('./main.js'); await startServer() }).catch((err) => {
  console.error('Fatal startup error:', err)
  process.exit(1)
})
