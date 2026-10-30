import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { envSchema } from '../config/env-schema.js'
import { IAM_VERSION } from '../config/version.js'
import { buildEnvSchemaDocument } from './env-doc.js'
import { PACKAGE_ROOT } from './paths.js'

const packageJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { name: string; version: string; bin: Record<string, string> }

describe('env-schema document', () => {
  const doc = buildEnvSchemaDocument()

  it('matches the package and the launcher contract', () => {
    expect(IAM_VERSION).toBe(packageJson.version)
    expect(doc).toMatchObject({
      service: 'iam',
      package: packageJson.name,
      version: packageJson.version,
      defaultPort: 4200,
      healthPath: '/api/v1/health/ready',
    })
    expect(packageJson.bin['hive-iam-server']).toBe('dist/cli.js')
    expect(doc.dependencies).toEqual([expect.objectContaining({ name: 'redis', envVar: 'REDIS_URL', default: 'redis://localhost:6379' })])
    expect(doc.dependencies[0]!.docker).toMatch(/^docker run -d --name hive-redis -p 127\.0\.0\.1:6379:6379 redis:\d+\.\d+\.\d+-alpine$/)
  })

  it('describes every variable once and lets the launcher generate required secrets', () => {
    const names = doc.env.map((entry) => entry.name)
    expect(new Set(names).size).toBe(names.length)
    for (const entry of doc.env) {
      expect(entry.description.length).toBeGreaterThan(10)
      if (entry.required && entry.secret) expect(entry.generate).toBeDefined()
      if (entry.generate) expect(entry.secret).toBe(true)
      if (entry.secret) expect(entry.default).toBeUndefined()
    }
    const required = doc.env.filter((entry) => entry.required).map((entry) => entry.name)
    expect(required.sort()).toEqual(['COOKIE_SECRET', 'IAM_AGENT_SECRET'])
    for (const name of ['COOKIE_SECRET', 'IAM_AGENT_SECRET', 'PORT', 'HOST', 'DATABASE_URL', 'REDIS_URL', 'JWT_ISSUER', 'TLS_CERT_PATH']) {
      expect(names).toContain(name)
      expect(Object.keys(envSchema.shape)).toContain(name)
    }
  })
})
