import type { PreviewRecord } from './types'

export type PreviewApplyRecovery =
  | {
      kind: 'pending_applied'
    }
  | {
      kind: 'current_retained'
    }
  | {
      kind: 'absent'
    }
  | {
      kind: 'unknown'
    }

export type PreviewRemovalRecovery =
  | {
      kind: 'absent'
    }
  | {
      kind: 'current_retained'
    }
  | {
      kind: 'unknown'
    }

/**
 * Classifies Caddy readback for a preview whose durable state is `applying`.
 *
 * This policy is intentionally pure. It does not decide whether an absent route
 * is safe to recreate, mutate persistence, issue provider calls, or publish
 * invalidations. The controller applies those contextual decisions.
 */
export function recoverApply(preview: PreviewRecord, observedDigest: string | null): PreviewApplyRecovery {
  if (observedDigest === null) {
    return {
      kind: 'absent',
    }
  }
  if (preview.pendingConfigurationDigest !== null && observedDigest === preview.pendingConfigurationDigest) {
    return {
      kind: 'pending_applied',
    }
  }
  if (preview.currentConfigurationDigest !== null && observedDigest === preview.currentConfigurationDigest) {
    return {
      kind: 'current_retained',
    }
  }
  return {
    kind: 'unknown',
  }
}

/**
 * Classifies Caddy readback for a preview whose durable state is `removing`.
 *
 * An absent route proves removal. A route matching the known current
 * configuration proves that removal did not take effect. Any other route shape
 * is outside durable withdrawal authority.
 */
export function recoverRemoval(preview: PreviewRecord, observedDigest: string | null): PreviewRemovalRecovery {
  if (observedDigest === null) {
    return {
      kind: 'absent',
    }
  }
  if (preview.currentConfigurationDigest !== null && observedDigest === preview.currentConfigurationDigest) {
    return {
      kind: 'current_retained',
    }
  }
  return {
    kind: 'unknown',
  }
}
