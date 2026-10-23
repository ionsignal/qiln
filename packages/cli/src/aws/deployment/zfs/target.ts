import { dataVolumeId, resourceId } from '../topology'
import type { ZfsTarget } from '../../../remote/zfs/types'
import type { Deployment } from '../types'

const GIB = 1_073_741_824

/**
 * Derives the preparation target from the protected deployment record alone.
 * Device paths and volume IDs never come from the operator or the host. Null
 * means the record lacks an identity, which callers treat as a defect.
 */
export function targetOf(record: Deployment): ZfsTarget | null {
  const instanceId = resourceId(record, 'run-instances')
  const dataId = dataVolumeId(record)
  const rootVolumeId = record.implicit?.rootVolumeId
  if (instanceId === null || dataId === null || rootVolumeId === undefined) {
    return null
  }
  return {
    instanceId,
    rootVolumeId,
    dataVolumeId: dataId,
    dataBytes: record.approval.host.plan.data.sizeGiB * GIB,
  }
}
