import {
  CapsuleBranchResourceCleanupPolicy,
  CapsuleBranchResourceStatus,
  CapsuleBranchResourceType,
  type CapsuleBranchResourceStatusValue,
} from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import {
  parseBindMountResourceMetadata,
  parseInstanceResourceMetadata,
  parseProjectResourceMetadata,
  parseProvisioningFileResourceMetadata,
  parseVolumeResourceMetadata,
} from '../../../resources/metadata'
import type { BranchDeletePlan, BranchDeletePlanInput, BranchDeleteResourceRow } from './types'

const ACTIONABLE_RESOURCE_STATUSES: ReadonlySet<CapsuleBranchResourceStatusValue> = new Set([
  CapsuleBranchResourceStatus.CREATED,
  CapsuleBranchResourceStatus.ADOPTED,
])

const TERMINAL_RESOURCE_STATUSES: ReadonlySet<CapsuleBranchResourceStatusValue> = new Set([
  CapsuleBranchResourceStatus.DELETED,
  CapsuleBranchResourceStatus.MISSING,
])

type DeleteResourceDisposition = 'actionable' | 'terminal'

/**
 * Builds an Incus deletion plan only from Qiln's verified durable inventory.
 *
 * This planner never inspects live instances, attached devices, or provider
 * state to reconstruct ownership. Any uncertain inventory is manual review.
 */
export class CapsuleBranchDeletePlanner {
  public createPlan(input: BranchDeletePlanInput): BranchDeletePlan {
    if (input.resources.length === 0) {
      throw this.manualReviewError('Capsule branch has no durable resource inventory.', {
        branchName: input.branchName,
        namespace: input.namespace,
      })
    }
    const plan: BranchDeletePlan = {
      instance: null,
      volumes: [],
      provisioningFileResourceIdsToFinalize: [],
    }
    let projectCount = 0
    let instanceCount = 0
    const volumeIdentities = new Set<string>()
    const provisioningFileIdentities = new Set<string>()
    for (const resource of input.resources) {
      this.assertIncusProvider(resource)
      switch (resource.resourceType) {
        case CapsuleBranchResourceType.INCUS_PROJECT: {
          projectCount += 1
          if (projectCount > 1) {
            throw this.manualReviewError('Capsule branch resource inventory contains multiple project resources.', {
              branchName: input.branchName,
              duplicateResourceId: resource.id,
            })
          }
          this.assertCleanupPolicy(resource, CapsuleBranchResourceCleanupPolicy.RETAIN)
          this.assertDisposition(resource, false)
          const metadata = this.parseMetadata(resource, parseProjectResourceMetadata, 'project')
          this.assertNamespace(resource, metadata.namespace, input.namespace)
          break
        }
        case CapsuleBranchResourceType.BIND_MOUNT: {
          this.assertCleanupPolicy(resource, CapsuleBranchResourceCleanupPolicy.EXTERNAL)
          this.assertDisposition(resource, false)
          const metadata = this.parseMetadata(resource, parseBindMountResourceMetadata, 'bind mount')
          this.assertNamespace(resource, metadata.namespace, input.namespace)
          break
        }
        case CapsuleBranchResourceType.INCUS_INSTANCE: {
          instanceCount += 1
          if (instanceCount > 1) {
            throw this.manualReviewError('Capsule branch resource inventory contains multiple managed instance resources.', {
              branchName: input.branchName,
              duplicateResourceId: resource.id,
            })
          }
          this.assertCleanupPolicy(resource, CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH)
          const metadata = this.parseMetadata(resource, parseInstanceResourceMetadata, 'instance')
          this.assertNamespace(resource, metadata.namespace, input.namespace)
          if (metadata.instanceName !== input.branchName) {
            throw this.manualReviewError('Capsule branch instance inventory does not match the branch identity.', {
              branchName: input.branchName,
              resourceId: resource.id,
              instanceName: metadata.instanceName,
            })
          }
          const disposition = this.assertDisposition(resource, true)
          if (disposition === 'actionable') {
            plan.instance = {
              resourceId: resource.id,
              instanceName: metadata.instanceName,
            }
          }
          break
        }
        case CapsuleBranchResourceType.ZFS_VOLUME: {
          this.assertCleanupPolicy(resource, CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH)
          const metadata = this.parseMetadata(resource, parseVolumeResourceMetadata, 'volume')
          this.assertNamespace(resource, metadata.namespace, input.namespace)
          const volumeIdentity = `${metadata.pool}\u0000${metadata.volumeName}`
          if (volumeIdentities.has(volumeIdentity)) {
            throw this.manualReviewError('Capsule branch resource inventory contains duplicate managed volume identity.', {
              branchName: input.branchName,
              resourceId: resource.id,
              pool: metadata.pool,
              volumeName: metadata.volumeName,
            })
          }
          volumeIdentities.add(volumeIdentity)
          if (this.assertDisposition(resource, true) === 'actionable') {
            plan.volumes.push({
              resourceId: resource.id,
              pool: metadata.pool,
              volumeName: metadata.volumeName,
            })
          }
          break
        }
        case CapsuleBranchResourceType.PROVISIONING_FILE: {
          this.assertCleanupPolicy(resource, CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH)
          const metadata = this.parseMetadata(resource, parseProvisioningFileResourceMetadata, 'provisioning file')
          this.assertNamespace(resource, metadata.namespace, input.namespace)
          if (metadata.branchName !== input.branchName) {
            throw this.manualReviewError('Capsule branch provisioning file inventory does not match the branch identity.', {
              branchName: input.branchName,
              resourceId: resource.id,
              recordedBranchName: metadata.branchName,
            })
          }
          const fileIdentity =
            metadata.target === 'volume'
              ? `volume\u0000${metadata.pool}\u0000${metadata.volumeName}\u0000${metadata.internalPath}`
              : `instance\u0000${metadata.branchName}\u0000${metadata.path}`
          if (provisioningFileIdentities.has(fileIdentity)) {
            throw this.manualReviewError('Capsule branch resource inventory contains duplicate provisioning file identity.', {
              branchName: input.branchName,
              resourceId: resource.id,
            })
          }
          provisioningFileIdentities.add(fileIdentity)
          if (this.assertDisposition(resource, true) === 'actionable') {
            plan.provisioningFileResourceIdsToFinalize.push(resource.id)
          }
          break
        }
        default: {
          const resourceType = resource.resourceType
          throw this.manualReviewError('Capsule branch resource inventory contains an unsupported resource type.', {
            branchName: input.branchName,
            resourceId: resource.id,
            resourceType,
          })
        }
      }
    }
    if (projectCount !== 1) {
      throw this.manualReviewError('Capsule branch resource inventory is missing its retained project resource.', {
        branchName: input.branchName,
        projectCount,
      })
    }
    if (instanceCount !== 1) {
      throw this.manualReviewError('Capsule branch resource inventory is missing its managed instance resource.', {
        branchName: input.branchName,
        instanceCount,
      })
    }
    return plan
  }

  private assertIncusProvider(resource: BranchDeleteResourceRow): void {
    if (resource.provider !== 'incus') {
      throw this.manualReviewError('Capsule branch resource inventory contains an unsupported provider.', {
        resourceId: resource.id,
        resourceKey: resource.resourceKey,
        provider: resource.provider,
      })
    }
  }

  private assertCleanupPolicy(
    resource: BranchDeleteResourceRow,
    expectedPolicy: (typeof CapsuleBranchResourceCleanupPolicy)[keyof typeof CapsuleBranchResourceCleanupPolicy],
  ): void {
    if (resource.cleanupPolicy !== expectedPolicy) {
      throw this.manualReviewError('Capsule branch resource inventory has an invalid cleanup policy.', {
        resourceId: resource.id,
        resourceKey: resource.resourceKey,
        resourceType: resource.resourceType,
        expectedPolicy,
        actualPolicy: resource.cleanupPolicy,
      })
    }
  }

  private assertDisposition(resource: BranchDeleteResourceRow, allowTerminal: boolean): DeleteResourceDisposition {
    if (ACTIONABLE_RESOURCE_STATUSES.has(resource.status)) {
      return 'actionable'
    }
    if (allowTerminal && TERMINAL_RESOURCE_STATUSES.has(resource.status)) {
      return 'terminal'
    }
    throw this.manualReviewError('Capsule branch resource inventory contains an uncertain resource state.', {
      resourceId: resource.id,
      resourceKey: resource.resourceKey,
      resourceType: resource.resourceType,
      status: resource.status,
    })
  }

  private parseMetadata<T>(resource: BranchDeleteResourceRow, parse: (value: unknown) => T, resourceLabel: string): T {
    try {
      return parse(resource.metadata)
    } catch (error: unknown) {
      throw this.manualReviewError(`Capsule branch ${resourceLabel} inventory metadata is invalid.`, {
        resourceId: resource.id,
        resourceKey: resource.resourceKey,
        reason: error instanceof Error ? error.message : 'Unknown metadata validation failure.',
      })
    }
  }

  private assertNamespace(resource: BranchDeleteResourceRow, actualNamespace: string, expectedNamespace: string): void {
    if (actualNamespace !== expectedNamespace) {
      throw this.manualReviewError('Capsule branch resource inventory namespace does not match the branch owner.', {
        resourceId: resource.id,
        resourceKey: resource.resourceKey,
        expectedNamespace,
        actualNamespace,
      })
    }
  }

  private manualReviewError(message: string, details: Record<string, unknown>): IncusError {
    return new IncusError(`${message} Manual review is required.`, 'CONFLICT', details)
  }
}
