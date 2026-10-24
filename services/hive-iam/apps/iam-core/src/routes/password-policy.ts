import { requireStepUp } from '../middleware/step-up.js';
import { Hono } from 'hono'
import { prisma } from '../db/client.js'
import { authMiddleware } from '../middleware/auth.js'
import { getDefaultPolicy, calculatePasswordStrength, validatePasswordPolicy } from '../services/password-policy-service.js'
import { parseBody } from '../utils/validate.js'
import { ApiError } from '../types/index.js'
import { z } from 'zod'

const UpdatePolicySchema = z.object({
  name: z.string().min(1).optional(),
  minLength: z.number().int().min(6).max(128).optional(),
  maxLength: z.number().int().min(8).max(256).optional(),
  requireUppercase: z.boolean().optional(),
  requireLowercase: z.boolean().optional(),
  requireNumbers: z.boolean().optional(),
  requireSpecial: z.boolean().optional(),
  maxAgeDays: z.number().int().min(0).max(365).optional(),
  historyCount: z.number().int().min(0).max(24).optional(),
  lockoutAttempts: z.number().int().min(1).max(100).optional(),
  lockoutDurationMin: z.number().int().min(1).max(1440).optional(),
})

const StrengthCheckSchema = z.object({
  password: z.string().min(1),
})

export const passwordPolicyRouter = new Hono()

// ── Get active password policy (public — login page needs it for strength meter) ──
passwordPolicyRouter.get('/', async (c) => {
  const policy = await getDefaultPolicy()
  // Don't expose internal ID
  return c.json({
    policy: {
      name: policy.name,
      minLength: policy.minLength,
      maxLength: policy.maxLength,
      requireUppercase: policy.requireUppercase,
      requireLowercase: policy.requireLowercase,
      requireNumbers: policy.requireNumbers,
      requireSpecial: policy.requireSpecial,
      maxAgeDays: policy.maxAgeDays,
      historyCount: policy.historyCount,
      lockoutAttempts: policy.lockoutAttempts,
      lockoutDurationMin: policy.lockoutDurationMin,
    },
  })
})

// ── Update password policy (ADMIN only) ──
passwordPolicyRouter.patch('/', authMiddleware, async (c, next) => {
  const principal = c.get('principal');
  if (principal?.actorType === 'USER') return requireStepUp({ threshold: 0 })(c, next);
  if (principal?.clientId === 'hive-router') {
    const raw = c.req.header('x-hive-operator');
    let operator: { id?: string; sessionId?: string; authenticatedAt?: number } = {};
    try { if (raw && raw.length < 2048) operator = JSON.parse(raw); } catch { /* Deny malformed operator context. */ }
    if (!operator.id || !operator.sessionId || typeof operator.authenticatedAt !== 'number' || Date.now() - operator.authenticatedAt > 900_000 || operator.authenticatedAt > Date.now() + 30_000) throw new ApiError(403, 'FORBIDDEN', 'Recent verified Router operator context required');
  }
  return next();
}, async (c) => {
  const principal = c.get('principal')
  const permissions: readonly string[] = principal?.permissions ?? []
  const roles: readonly string[] = principal?.roles ?? []
  if (!roles.includes('admin') && !roles.includes('super_admin') && !permissions.includes('iam:policy:write')) {
    throw new ApiError(403, 'FORBIDDEN', 'Admin access required')
  }

  const data = await parseBody(c, UpdatePolicySchema)
  const policy = await getDefaultPolicy()

  // Validate minLength < maxLength
  const newMin = data.minLength ?? policy.minLength
  const newMax = data.maxLength ?? policy.maxLength
  if (newMin > newMax) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'minLength must not exceed maxLength')
  }

  const updated = await prisma.passwordPolicy.update({
    where: { id: policy.id },
    data,
  })

  return c.json({ policy: updated })
})

// ── Check password strength (public — for strength meters) ──
passwordPolicyRouter.post('/strength', async (c) => {
  const { password } = await parseBody(c, StrengthCheckSchema)
  const policy = await getDefaultPolicy()
  const errors = validatePasswordPolicy(password, policy)
  const strength = calculatePasswordStrength(password)

  return c.json({
    strength,
    meetsPolicy: errors.length === 0,
    errors,
  })
})
