import { validateEnv, type Env } from './env-schema.js'

export type { Env }

function parseEnv(): Env {
  const result = validateEnv(process.env)
  if (!result.ok) {
    for (const line of result.errors) console.error(line)
    process.exit(1)
  }
  return result.env
}

export const env = parseEnv()
