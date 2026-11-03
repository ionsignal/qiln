import { InstallerError } from '../../diagnostic/error'
import type { ConfigurePlan } from '../journal/types'
import type { CheckoutAccess } from '../target/types'

/**
 * - operator: the operator's own checkout, which Qiln validates and never manages.
 * - present: the managed checkout exists with a valid identity. `pinned` says
 *   whether a restore point is recorded for it.
 * - absent: the managed checkout is missing. `commit` is the recorded restore
 *   point, or origin's current main when none is recorded yet.
 */
export type CheckoutState =
  | { kind: 'operator' }
  | { kind: 'present'; pinned: boolean }
  | { kind: 'absent'; commit: string; pinned: boolean }

/**
 * Pure decision over one observed checkout. Only an absent managed checkout is
 * materialized, and HEAD and the working tree of a present one are never judged.
 * A present checkout without a recorded restore point is not Qiln's to adopt.
 */
export function checkoutPlanOf(state: CheckoutState, retry: string): ConfigurePlan['checkout'] {
  switch (state.kind) {
    case 'operator':
      return null
    case 'present':
      if (!state.pinned) {
        throw new InstallerError({
          code: 'SOURCE_CHECKOUT_CONFLICT',
          facts: [['Reason', 'A checkout exists at the managed path, but no restore point is recorded for it.']],
          retry,
        })
      }
      return null
    case 'absent':
      return { commit: state.commit, pin: !state.pinned }
  }
}

/**
 * The canonical checkout root. A managed checkout has a derived path and needs
 * no request. An operator checkout must have been named, and is validated.
 */
export async function rootOf(checkout: CheckoutAccess, requested: string | null, retry: string): Promise<string> {
  if (checkout.kind === 'managed') {
    return checkout.path
  }
  if (requested === null) {
    throw new InstallerError({
      code: 'SOURCE_REQUIRED',
      facts: [['Observed', 'No host Qiln checkout was selected.']],
      retry,
    })
  }
  return await checkout.root(requested)
}
