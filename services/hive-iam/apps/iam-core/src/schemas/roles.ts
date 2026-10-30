import { z } from 'zod'

export const CreateRoleSchema = z.object({
  name: z.string().min(2).max(64).regex(/^[A-Z0-9_]+$/),
  label: z.string().min(1).max(128),
  description: z.string().optional(),
  permissions: z.array(z.string()).default([]),
})

export const UpdateRoleSchema = z.object({
  label: z.string().min(1).max(128).optional(),
  description: z.string().optional(),
  permissions: z.array(z.string()).optional(),
})
