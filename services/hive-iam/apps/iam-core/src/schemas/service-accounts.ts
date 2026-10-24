import { z } from 'zod'

export const CreateServiceAccountSchema = z.object({
  operationId: z.string().min(16).max(128).optional(),
  name: z.string().min(2).max(128),
  description: z.string().optional(),
  clientId: z.string().min(1),
  roleIds: z.array(z.string()).default([]),
  expiresAt: z.iso.datetime().optional(),
  allowedIps: z.array(z.ipv4()).default([]),
})

export const UpdateServiceAccountSchema = z.object({
  description: z.string().optional(),
  active: z.boolean().optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
  allowedIps: z.array(z.ipv4()).optional(),
})
