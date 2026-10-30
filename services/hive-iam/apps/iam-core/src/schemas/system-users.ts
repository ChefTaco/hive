import { z } from 'zod'

export const CreateSystemUserSchema = z.object({
  userId: z.string().min(1),
  linuxUsername: z.string().min(1).max(32).regex(/^[a-z][a-z0-9_-]*$/),
  sudoEnabled: z.boolean().default(false),
  sshPublicKey: z.string().optional(),
  authorizedHosts: z.array(z.string()).default([]),
})

export const UpdateSystemUserSchema = z.object({
  sudoEnabled: z.boolean().optional(),
  sshPublicKey: z.string().nullable().optional(),
  authorizedHosts: z.array(z.string()).optional(),
})

export const SystemLoginCheckSchema = z.object({
  linuxUsername: z.string().min(1),
  clientIp: z.string(),
  hostName: z.string().min(1),
  agentToken: z.string().min(1),
})
