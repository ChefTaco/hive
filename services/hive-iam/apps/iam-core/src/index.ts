// Production entry point (systemd runs `node dist/index.js` from the install
// directory). The `hive-iam-server` CLI lives in cli.ts.
import 'dotenv/config'
import { startServer } from './main.js'

startServer().catch((err) => {
  console.error('Fatal startup error:', err)
  process.exit(1)
})
