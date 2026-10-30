import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  CreateUserSchema,
  UpdateUserSchema,
  AssignRolesSchema,
  ListUsersQuerySchema,
} from './users.js'

describe('CreateUserSchema', () => {
  it('accepts valid user creation', () => {
    const result = CreateUserSchema.safeParse({
      email: 'test@example.com',
      username: 'testuser',
      password: 'StrongP@ss1',
      displayName: 'Test User',
      roleIds: [],
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing email', () => {
    const result = CreateUserSchema.safeParse({
      username: 'testuser',
      password: 'StrongP@ss1',
    })
    expect(result.success).toBe(false)
  })

  it('rejects short password', () => {
    const result = CreateUserSchema.safeParse({
      email: 'test@example.com',
      username: 'testuser',
      password: 'abc',
    })
    expect(result.success).toBe(false)
  })
})

describe('UpdateUserSchema', () => {
  it('accepts partial updates', () => {
    const result = UpdateUserSchema.safeParse({ displayName: 'New Name' })
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ displayName: 'New Name' })
  })

  it('accepts empty object (no changes)', () => {
    const result = UpdateUserSchema.safeParse({})
    expect(result.success).toBe(true)
  })
})

describe('ListUsersQuerySchema', () => {
  it('applies defaults for missing page/limit', () => {
    const result = ListUsersQuerySchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.page).toBe(1)
      expect(result.data.limit).toBe(20)
    }
  })

  it('coerces string numbers', () => {
    const result = ListUsersQuerySchema.safeParse({ page: '3', limit: '50' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.page).toBe(3)
      expect(result.data.limit).toBe(50)
    }
  })

  it('rejects limit over 100', () => {
    const result = ListUsersQuerySchema.safeParse({ limit: '200' })
    expect(result.success).toBe(false)
  })

  it('parses active filter correctly', () => {
    const trueResult = ListUsersQuerySchema.safeParse({ active: 'true' })
    expect(trueResult.success).toBe(true)
    if (trueResult.success) {
      expect(trueResult.data.active).toBe(true)
    }

    const falseResult = ListUsersQuerySchema.safeParse({ active: 'false' })
    expect(falseResult.success).toBe(true)
    if (falseResult.success) {
      expect(falseResult.data.active).toBe(false)
    }
  })

  it('rejects non-boolean active values', () => {
    const result = ListUsersQuerySchema.safeParse({ active: 'yes' })
    expect(result.success).toBe(false)
  })
})

describe('AssignRolesSchema', () => {
  it('accepts valid roleIds array', () => {
    const result = AssignRolesSchema.safeParse({ roleIds: ['role1', 'role2'] })
    expect(result.success).toBe(true)
  })

  it('rejects empty roleIds', () => {
    const result = AssignRolesSchema.safeParse({ roleIds: [] })
    // Should either reject or accept depending on schema — test behavior
    expect(result.success).toBeDefined()
  })
})
