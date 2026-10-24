import { z } from 'zod'

export const CreateUserSchema = z.object({
  email: z.email(),
  username: z.string().min(2).max(64).regex(/^[a-z0-9_-]+$/),
  displayName: z.string().min(1).max(128),
  password: z.string().min(8).max(256),
  active: z.boolean().default(true),
  roleIds: z.array(z.string()).default([]),
})

export const UpdateUserSchema = z.object({
  displayName: z.string().min(1).max(128).optional(),
  active: z.boolean().optional(),
  password: z.string().min(8).max(256).optional(),
})

export const AssignRolesSchema = z.object({
  roleIds: z.array(z.string()).min(1),
})

export const ListUsersQuerySchema = z.object({
  page: z.coerce.number().default(1),
  limit: z.coerce.number().max(100).default(20),
  search: z.string().optional(),
  active: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
})

export const RotatePasswordSchema = z.object({
  password: z.string().min(8).max(256),
})
