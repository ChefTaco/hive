import { describe, it, expect } from 'vitest'
import { ApiError } from './index.js'

describe('ApiError', () => {
  it('constructs with status, code, and message', () => {
    const err = new ApiError(404, 'NOT_FOUND', 'User not found')
    expect(err.status).toBe(404)
    expect(err.code).toBe('NOT_FOUND')
    expect(err.message).toBe('User not found')
    expect(err.name).toBe('ApiError')
  })

  it('is an instance of Error', () => {
    const err = new ApiError(500, 'INTERNAL', 'Something broke')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(ApiError)
  })

  it('preserves stack trace', () => {
    const err = new ApiError(400, 'BAD_REQUEST', 'Missing field')
    expect(err.stack).toBeDefined()
    expect(err.stack).toContain('ApiError')
  })
})
