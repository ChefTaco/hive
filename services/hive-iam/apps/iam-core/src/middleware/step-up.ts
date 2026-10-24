import type { MiddlewareHandler } from 'hono'
import { prisma } from '../db/client.js'
import { ApiError } from '../types/index.js'

const STEP_UP_VALIDITY_MS = 15 * 60 * 1000 // 15 minutes
const HIGH_RISK_THRESHOLD = 0.5

/**
 * Middleware that requires step-up authentication for high-risk sessions.
 * Must be placed AFTER authMiddleware.
 *
 * If the session risk score >= threshold and step-up has not been
 * verified recently, returns 403 with a `step_up_required` error code.
 */
export function requireStepUp(opts?: { threshold?: number; validityMs?: number }): MiddlewareHandler {
  const threshold = opts?.threshold ?? HIGH_RISK_THRESHOLD
  const validityMs = opts?.validityMs ?? STEP_UP_VALIDITY_MS

  return async (c, next) => {
    const principal = c.get('principal')
    if (!principal?.sessionId) {
      throw new ApiError(403, 'FORBIDDEN', 'Session context required for step-up auth')
    }

    const session = await prisma.session.findUnique({
      where: { id: principal.sessionId },
      select: { riskScore: true, riskFactors: true, stepUpVerifiedAt: true },
    })

    if (!session) {
      throw new ApiError(403, 'FORBIDDEN', 'Session not found')
    }

    // Low-risk sessions pass through without step-up
    if (session.riskScore < threshold) {
      return next()
    }

    // Check if step-up was recently verified
    if (session.stepUpVerifiedAt) {
      const elapsed = Date.now() - new Date(session.stepUpVerifiedAt).getTime()
      if (elapsed < validityMs) {
        return next()
      }
    }

    // Require step-up
    return c.json(
      {
        error: 'STEP_UP_REQUIRED',
        message: 'This action requires re-authentication due to elevated session risk',
        riskScore: session.riskScore,
        riskFactors: session.riskFactors ? JSON.parse(session.riskFactors) : [],
      },
      403,
    )
  }
}

/**
 * Mark a session as having completed step-up verification.
 */
export async function completeStepUp(sessionId: string): Promise<void> {
  await prisma.session.update({
    where: { id: sessionId },
    data: { stepUpVerifiedAt: new Date() },
  })
}
