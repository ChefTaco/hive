import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { ApiError } from '../types/index.js'

// Import the function under test
import { parseBody } from './validate.js'

// Helper to create a minimal Hono-like context
function mockContext(body: unknown) {
  return {
    req: {
      async json() {
        if (body === '__INVALID__') throw new SyntaxError('Unexpected token')
        return body
      },
    },
  } as Parameters<typeof parseBody>[0]
}

const TestSchema = z.object({
  name: z.string().min(1),
  age: z.number().int().positive(),
})

describe('parseBody', () => {
  it('parses valid JSON body against schema', async () => {
    const c = mockContext({ name: 'Alice', age: 30 })
    const result = await parseBody(c, TestSchema)
    expect(result).toEqual({ name: 'Alice', age: 30 })
  })

  it('strips unknown fields', async () => {
    const c = mockContext({ name: 'Bob', age: 25, extra: 'ignored' })
    const result = await parseBody(c, TestSchema)
    expect(result).toEqual({ name: 'Bob', age: 25 })
    expect(result).not.toHaveProperty('extra')
  })

  it('throws ApiError 400 for invalid JSON', async () => {
    const c = mockContext('__INVALID__')
    await expect(parseBody(c, TestSchema)).rejects.toThrow(ApiError)
    try {
      await parseBody(c, TestSchema)
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).status).toBe(400)
      expect((err as ApiError).code).toBe('INVALID_JSON')
    }
  })

  it('throws ApiError 400 for schema validation failure', async () => {
    const c = mockContext({ name: '', age: -1 })
    try {
      await parseBody(c, TestSchema)
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).status).toBe(400)
      expect((err as ApiError).code).toBe('VALIDATION_ERROR')
    }
  })

  it('includes field names in validation error message', async () => {
    const c = mockContext({ name: 123, age: 'not a number' })
    try {
      await parseBody(c, TestSchema)
      expect.fail('should have thrown')
    } catch (err) {
      expect((err as ApiError).message).toContain('name')
    }
  })
})
