import { identityOf } from '../journal/binding'
import type { ZfsTarget } from '../../../host/zfs/types'
import type { Deployment } from '../types'

const GIB = 1_073_741_824

/**
 * Derives the preparation target from the protected deployment record alone.
 * Device paths and volume IDs never come from the operator or the host. Null
 * means the record lacks an identity, which callers treat as a defect.
 */
export function targetOf(record: Deployment): ZfsTarget | null {
  const identity = identityOf(record)
  if (identity === null) {
    return null
  }
  return {
    ...identity,
    dataBytes: record.approval.host.plan.data.sizeGiB * GIB,
  }
}
