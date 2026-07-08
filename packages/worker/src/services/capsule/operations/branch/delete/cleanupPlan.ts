import {
  CapsuleBranchResourceCleanupPolicy,
  CapsuleBranchResourceStatus,
  CapsuleBranchResourceType,
  type CapsuleBranchResourceStatus as CapsuleBranchResourceStatusValue,
} from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import { parseInstanceResourceMetadata, parseProvisioningFileResourceMetadata, parseVolumeResourceMetadata } from '../../../resources/metadata'
import type { BranchDeleteCleanupPlan, BranchDeleteResourceRow } from './types'

const TERMINAL_RESOURCE_STATUSES: ReadonlySet<CapsuleBranchResourceStatusValue> = new Set([
  CapsuleBranchResourceStatus.DELETED,
  CapsuleBranchResourceStatus.MISSING,
])

export function createBranchDeleteCleanupPlan(resources: readonly BranchDeleteResourceRow[]): BranchDeleteCleanupPlan {
  const plan: BranchDeleteCleanupPlan = {
    instance: null,
    volumes: [],
    provisioningFileResourceIds: [],
    retainedResourceIds: [],
    externalResourceIds: [],
  }
  for (const resource of resources) {
    if (resource.cleanupPolicy === CapsuleBranchResourceCleanupPolicy.RETAIN) {
      plan.retainedResourceIds.push(resource.id)
      continue
    }
    if (resource.cleanupPolicy === CapsuleBranchResourceCleanupPolicy.EXTERNAL) {
      plan.externalResourceIds.push(resource.id)
      continue
    }
    if (TERMINAL_RESOURCE_STATUSES.has(resource.status)) {
      continue
    }
    if (resource.cleanupPolicy !== CapsuleBranchResourceCleanupPolicy.DELETE_ON_ROLLBACK) {
      continue
    }
    switch (resource.resourceType) {
      case CapsuleBranchResourceType.INCUS_INSTANCE: {
        const metadata = parseInstanceResourceMetadata(resource.metadata)
        if (plan.instance) {
          throw new IncusError('Capsule branch resource inventory contains multiple managed instance resources.', 'VALIDATION_ERROR', {
            firstResourceId: plan.instance.resourceId,
            duplicateResourceId: resource.id,
          })
        }
        plan.instance = {
          resourceId: resource.id,
          instanceName: metadata.instanceName,
        }
        break
      }
      case CapsuleBranchResourceType.ZFS_VOLUME: {
        const metadata = parseVolumeResourceMetadata(resource.metadata)
        plan.volumes.push({
          resourceId: resource.id,
          pool: metadata.pool,
          volumeName: metadata.volumeName,
        })
        break
      }
      case CapsuleBranchResourceType.PROVISIONING_FILE:
        parseProvisioningFileResourceMetadata(resource.metadata)
        plan.provisioningFileResourceIds.push(resource.id)
        break
      case CapsuleBranchResourceType.INCUS_PROJECT:
        plan.retainedResourceIds.push(resource.id)
        break
      case CapsuleBranchResourceType.BIND_MOUNT:
        plan.externalResourceIds.push(resource.id)
        break
      default: {
        const resourceType: never = resource.resourceType
        throw new IncusError('Unknown capsule branch resource type in delete cleanup plan.', 'VALIDATION_ERROR', {
          resourceId: resource.id,
          resourceType,
        })
      }
    }
  }
  return plan
}
