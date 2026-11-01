import { readFileSync } from 'node:fs'

// Contract generation imports this before the bundled upgrade runtime is built.
// src/config and dist/config share the same path to the package manifest.
export const IAM_VERSION = (JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string }).version
