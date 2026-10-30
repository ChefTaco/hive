import { Hono } from 'hono'
import { swaggerUI } from '@hono/swagger-ui'
import { buildOpenApiSpec } from '../openapi/spec.js'

export const docsRouter = new Hono()

let cachedSpec: ReturnType<typeof buildOpenApiSpec> | null = null
function getSpec() {
  if (!cachedSpec) cachedSpec = buildOpenApiSpec()
  return cachedSpec
}

docsRouter.get('/openapi.json', (c) => c.json(getSpec()))
docsRouter.get('/', swaggerUI({ url: '/api/docs/openapi.json' }))
