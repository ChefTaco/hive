import { z } from 'zod'

const VALID_GRANT_TYPES = ['authorization_code', 'refresh_token', 'client_credentials'] as const

export const CreateClientSchema = z.object({
  name: z.string().min(2).max(128).regex(/^[a-z0-9-]+$/),
  description: z.string().optional(),
  secret: z.string().min(16).optional(),
  clientType: z.enum(['public', 'confidential']).default('confidential'),
  redirectUris: z.array(z.url()).default([]),
  grantTypes: z.array(z.enum(VALID_GRANT_TYPES)).default(['authorization_code', 'refresh_token']),
  firstParty: z.boolean().default(false),
  allowedIps: z.array(z.ipv4()).default([]),
}).refine(
  (data) => data.clientType === 'public' || data.secret,
  { error: 'Confidential clients must provide a secret', path: ['secret'] },
).refine(
  (data) => data.clientType !== 'public' || !data.grantTypes.includes('client_credentials'),
  { error: 'Public clients cannot use client_credentials grant', path: ['grantTypes'] },
)

export const UpdateClientSchema = z.object({
  description: z.string().optional(),
  active: z.boolean().optional(),
  redirectUris: z.array(z.url()).optional(),
  grantTypes: z.array(z.enum(VALID_GRANT_TYPES)).optional(),
  firstParty: z.boolean().optional(),
  allowedIps: z.array(z.ipv4()).optional(),
})

export const RotateClientSecretSchema = z.object({
  secret: z.string().min(32),
})
