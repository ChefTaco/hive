import { createHash } from 'node:crypto';
import argon2 from 'argon2'
import { nanoid } from 'nanoid'
import { prisma } from '../db/client.js'
import { ApiError } from '../types/index.js'
import { checkIpAllowlist } from '../utils/ip-allowlist.js'

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
}

function generateApiKey(): { raw: string; prefix: string } {
  const prefix = nanoid(8)
  const secret = nanoid(32)
  return { raw: `sa_${prefix}.${secret}`, prefix }
}

export async function createServiceAccount(
  name: string,
  clientId: string,
  roleIds: string[],
  opts: {
    operationId?: string
    description?: string
    expiresAt?: Date
    allowedIps?: string[]
    createdBy?: string
  },
): Promise<{ id: string; apiKey: string }> {
  const provisionId = opts.operationId ? createHash('sha256').update((opts.createdBy ?? '') + ':' + opts.operationId).digest('hex') : undefined;
  const provisionDigest = provisionId ? createHash('sha256').update(JSON.stringify([name, clientId, roleIds, opts.description, opts.expiresAt, opts.allowedIps])).digest('hex') : undefined;
  if (provisionId) {
    const existing = await prisma.serviceAccount.findUnique({ where: { provisionId } });
    if (existing) {
      if (existing.provisionDigest !== provisionDigest) throw new ApiError(409, 'CONFLICT', 'Enrollment payload changed');
      return { id: existing.id, apiKey: '' };
    }
  }
  // Validate client exists
  const client = await prisma.client.findUnique({ where: { id: clientId } })
  if (!client) throw new ApiError(400, 'VALIDATION_ERROR', `Client not found: ${clientId}`)

  // Validate all roles exist
  if (roleIds.length > 0) {
    const existingRoles = await prisma.role.findMany({ where: { id: { in: roleIds } }, select: { id: true } })
    const found = new Set(existingRoles.map((r) => r.id))
    const missing = roleIds.filter((id) => !found.has(id))
    if (missing.length > 0) throw new ApiError(400, 'VALIDATION_ERROR', `Roles not found: ${missing.join(', ')}`)
  }

  const { raw, prefix } = generateApiKey()
  const apiKeyHash = await argon2.hash(raw, ARGON2_OPTIONS)

  const sa = await prisma.serviceAccount.create({
    data: {
      name,
      provisionId,
      provisionDigest,
      description: opts.description,
      clientId,
      apiKeyHash,
      apiKeyPrefix: prefix,
      expiresAt: opts.expiresAt,
      allowedIps: JSON.stringify(opts.allowedIps ?? []),
      createdBy: opts.createdBy,
      roles: {
        create: roleIds.map((roleId) => ({ roleId })),
      },
    },
  })

  return { id: sa.id, apiKey: raw }
}

export async function rotateApiKey(saId: string): Promise<string> {
  const { raw, prefix } = generateApiKey()
  const apiKeyHash = await argon2.hash(raw, ARGON2_OPTIONS)

  await prisma.serviceAccount.update({
    where: { id: saId },
    data: { apiKeyHash, apiKeyPrefix: prefix, updatedAt: new Date() },
  })

  return raw
}

export interface SaAuthResult {
  id: string
  clientId: string
  roles: string[]
  permissions: string[]
}

export async function authenticateServiceAccount(
  rawApiKey: string,
  ipAddress: string,
): Promise<SaAuthResult> {
  // Key format: sa_<prefix>.<secret> — prefix is 8 chars
  if (!rawApiKey.startsWith('sa_')) {
    throw new ApiError(401, 'INVALID_API_KEY', 'Invalid API key format')
  }

  // Parse prefix to narrow database query instead of scanning all accounts
  const withoutPrefix = rawApiKey.slice(3) // remove 'sa_'
  const dotIdx = withoutPrefix.indexOf('.')
  if (dotIdx === -1) {
    throw new ApiError(401, 'INVALID_API_KEY', 'Invalid API key format')
  }
  const keyPrefix = withoutPrefix.slice(0, dotIdx)

  const candidates = await prisma.serviceAccount.findMany({
    where: { active: true, apiKeyPrefix: keyPrefix },
    include: { roles: { include: { role: true } } },
  })

  for (const sa of candidates) {
    const match = await argon2.verify(sa.apiKeyHash, rawApiKey, ARGON2_OPTIONS)
    if (match) {
      // Check expiry
      if (sa.expiresAt && sa.expiresAt < new Date()) {
        throw new ApiError(401, 'SA_EXPIRED', 'Service account has expired')
      }

      // Check IP allowlist (supports exact, CIDR, wildcard)
      const allowedIps: string[] = JSON.parse((sa.allowedIps as string) || '[]')
      if (!checkIpAllowlist(allowedIps, ipAddress)) {
        throw new ApiError(403, 'IP_NOT_ALLOWED', 'IP address not in service account allowlist')
      }

      // Update last used
      await prisma.serviceAccount.update({
        where: { id: sa.id },
        data: { lastUsedAt: new Date(), lastUsedIp: ipAddress },
      })

      const roles = sa.roles.map((r) => r.role.name)
      const permissions: string[] = [...new Set(sa.roles.flatMap((r) => {
        const perms = r.role.permissions
        return (typeof perms === 'string' ? JSON.parse(perms) : perms) as string[]
      }))]

      return { id: sa.id, clientId: sa.clientId, roles, permissions }
    }
  }

  throw new ApiError(401, 'INVALID_API_KEY', 'API key not found or inactive')
}
