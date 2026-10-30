export type SeedClientSecretPlan = 'create' | 'provision' | 'preserve'

interface PlanSeedClientSecretInput {
  clientName: string
  envName: string
  clientExists: boolean
  existingSecretHash: string | null
  suppliedSecret: string | undefined
}

/**
 * Decide whether an idempotent seed needs to hash a client secret.
 * Existing hashes are deliberately immutable here; rotation belongs to the
 * authenticated, audited client-secret rotation endpoint.
 */
export function planSeedClientSecret(input: PlanSeedClientSecretInput): SeedClientSecretPlan {
  if (!input.clientExists) {
    if (!input.suppliedSecret) {
      throw new Error(
        `${input.envName} is required when creating the confidential ${input.clientName} client`,
      )
    }
    return 'create'
  }

  if (!input.existingSecretHash) {
    if (!input.suppliedSecret) {
      throw new Error(
        `${input.envName} is required to provision the confidential ${input.clientName} client`,
      )
    }
    return 'provision'
  }

  return 'preserve'
}
