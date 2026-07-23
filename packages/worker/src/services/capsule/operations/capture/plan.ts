import {
  CapsuleBranchResourceCleanupPolicy,
  CapsuleBranchResourceStatus,
  CapsuleBranchResourceType,
  type CapsuleSnapshotCapturePolicyPin,
} from '@qiln/core/server'
import { IncusError } from '../../../../errors'
import { assertCapsuleBranchResourceInventoryMatches, type CapsuleBranchResourceInventoryRow } from '../../resource'
import { parseBindMountResourceMetadata, parseVolumeResourceMetadata } from '../../resource/metadata'
import { bindMountResourceKey, volumeResourceKey } from '../../resource/identity'
import type {
  CaptureDependencyPlan,
  CapturePlan,
  CaptureResourceRecord,
  CaptureRootPlan,
  CaptureSourceBranch,
} from './types'

function compareStableString(left: string, right: string): number {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}

function requireSingleResource(
  resources: readonly CapsuleBranchResourceInventoryRow[],
  message: string,
  details: Record<string, unknown>,
): CapsuleBranchResourceInventoryRow {
  if (resources.length !== 1) {
    throw new IncusError(message, 'CONFLICT', {
      ...details,
      resourceCount: resources.length,
    })
  }
  return resources[0]!
}

/**
 * Builds the deterministic pre-provider Snapshot Capture plan exclusively from
 * the historical capture-policy pin and durable branch resource inventory.
 *
 * This planner performs no SQL, provider reads, provider mutations, registry
 * access, dependency resolution, or artifact collection.
 */
export class CapturePlanner {
  public create(
    operationId: string,
    ownerId: string,
    capsuleId: string,
    branch: CaptureSourceBranch,
    policy: CapsuleSnapshotCapturePolicyPin,
    resources: readonly CapsuleBranchResourceInventoryRow[],
  ): CapturePlan {
    if (branch.ownerId !== ownerId || branch.capsuleId !== capsuleId) {
      throw new IncusError('Snapshot Capture source branch identity does not match its capsule owner.', 'CONFLICT', {
        operationId,
        ownerId,
        capsuleId,
        sourceBranchId: branch.id,
        sourceBranchOwnerId: branch.ownerId,
        sourceBranchCapsuleId: branch.capsuleId,
      })
    }
    if (branch.resourceInventoryDigest === null) {
      throw new IncusError('Snapshot Capture source branch has no durable resource inventory proof.', 'CONFLICT', {
        operationId,
        capsuleId,
        sourceBranchId: branch.id,
      })
    }
    if (branch.blueprintName !== policy.blueprintName || branch.blueprintDigest !== policy.blueprintDigest) {
      throw new IncusError('Snapshot Capture policy does not match the source branch blueprint identity.', 'CONFLICT', {
        operationId,
        capsuleId,
        sourceBranchId: branch.id,
        branchBlueprintName: branch.blueprintName,
        policyBlueprintName: policy.blueprintName,
        branchBlueprintDigest: branch.blueprintDigest,
        policyBlueprintDigest: policy.blueprintDigest,
      })
    }

    this.assertResourceOwnership(operationId, ownerId, branch, resources)

    assertCapsuleBranchResourceInventoryMatches(
      branch.resourceInventoryDigest,
      resources.map(resource => ({
        provider: resource.provider,
        resourceType: resource.resourceType,
        resourceKey: resource.resourceKey,
        blueprintVolumeName: resource.blueprintVolumeName,
        cleanupPolicy: resource.cleanupPolicy,
        metadata: resource.metadata,
      })),
    )

    if (policy.artifactRoots.length !== 1 || policy.artifactRoots[0]?.required !== true) {
      throw new IncusError(
        'Evaluation-only Snapshot Capture requires exactly one required managed artifact root.',
        'CONFLICT',
        {
          operationId,
          capsuleId,
          sourceBranchId: branch.id,
          artifactRootCount: policy.artifactRoots.length,
          requiredArtifactRootCount: policy.artifactRoots.filter(root => root.required).length,
        },
      )
    }

    const roots = policy.artifactRoots
      .map<CaptureRootPlan>(root => {
        const candidates = resources.filter(resource => resource.blueprintVolumeName === root.blueprintVolumeName)
        const resource = requireSingleResource(
          candidates,
          `Snapshot Capture artifact root '${root.id}' does not resolve exactly one source branch resource.`,
          {
            operationId,
            capsuleId,
            sourceBranchId: branch.id,
            artifactRootId: root.id,
            blueprintVolumeName: root.blueprintVolumeName,
          },
        )

        if (
          resource.provider !== 'incus' ||
          resource.resourceType !== CapsuleBranchResourceType.ZFS_VOLUME ||
          resource.cleanupPolicy !== CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH ||
          resource.status !== CapsuleBranchResourceStatus.CREATED
        ) {
          throw new IncusError(
            `Snapshot Capture artifact root '${root.id}' is not backed by an eligible managed volume.`,
            'CONFLICT',
            {
              operationId,
              capsuleId,
              sourceBranchId: branch.id,
              artifactRootId: root.id,
              resourceId: resource.id,
              provider: resource.provider,
              resourceType: resource.resourceType,
              cleanupPolicy: resource.cleanupPolicy,
              resourceStatus: resource.status,
            },
          )
        }

        const metadata = parseVolumeResourceMetadata(resource.metadata)
        const expectedNamespace = `user-${ownerId}`
        const expectedResourceKey = volumeResourceKey(metadata.namespace, metadata.pool, metadata.volumeName)

        if (
          metadata.namespace !== expectedNamespace ||
          metadata.mountPath !== root.logicalPath ||
          resource.resourceKey !== expectedResourceKey
        ) {
          throw new IncusError(
            `Snapshot Capture artifact root '${root.id}' has contradictory durable provider identity.`,
            'CONFLICT',
            {
              operationId,
              capsuleId,
              sourceBranchId: branch.id,
              artifactRootId: root.id,
              resourceId: resource.id,
              expectedNamespace,
              actualNamespace: metadata.namespace,
              expectedLogicalPath: root.logicalPath,
              actualMountPath: metadata.mountPath,
              expectedResourceKey,
              actualResourceKey: resource.resourceKey,
            },
          )
        }

        return {
          artifactRootId: root.id,
          blueprintVolumeName: root.blueprintVolumeName,
          sourceBranchResourceId: resource.id,
          provider: 'incus',
          kind: 'custom_volume_snapshot',
          project: metadata.namespace,
          pool: metadata.pool,
          sourceVolume: metadata.volumeName,
          snapshotName: this.snapshotName(operationId, root.id),
        }
      })
      .sort((left, right) => compareStableString(left.artifactRootId, right.artifactRootId))

    const dependencies = policy.externalMounts
      .map<CaptureDependencyPlan>(mount => {
        const candidates = resources.filter(resource => resource.blueprintVolumeName === mount.blueprintVolumeName)
        const resource = requireSingleResource(
          candidates,
          `Snapshot Capture external mount '${mount.blueprintVolumeName}' does not resolve exactly one source branch resource.`,
          {
            operationId,
            capsuleId,
            sourceBranchId: branch.id,
            artifactRootId: mount.artifactRootId,
            blueprintVolumeName: mount.blueprintVolumeName,
          },
        )

        if (
          resource.provider !== 'incus' ||
          resource.resourceType !== CapsuleBranchResourceType.BIND_MOUNT ||
          resource.cleanupPolicy !== CapsuleBranchResourceCleanupPolicy.EXTERNAL ||
          resource.status !== CapsuleBranchResourceStatus.ADOPTED
        ) {
          throw new IncusError(
            `Snapshot Capture external mount '${mount.blueprintVolumeName}' is not an eligible immutable dependency boundary.`,
            'CONFLICT',
            {
              operationId,
              capsuleId,
              sourceBranchId: branch.id,
              artifactRootId: mount.artifactRootId,
              resourceId: resource.id,
              provider: resource.provider,
              resourceType: resource.resourceType,
              cleanupPolicy: resource.cleanupPolicy,
              resourceStatus: resource.status,
            },
          )
        }

        const metadata = parseBindMountResourceMetadata(resource.metadata)
        const expectedNamespace = `user-${ownerId}`
        const expectedResourceKey = bindMountResourceKey(metadata.namespace, metadata.hostPath, metadata.mountPath)

        if (
          metadata.namespace !== expectedNamespace ||
          metadata.mountPath !== mount.logicalPath ||
          metadata.readonly !== true ||
          resource.resourceKey !== expectedResourceKey
        ) {
          throw new IncusError(
            `Snapshot Capture external mount '${mount.blueprintVolumeName}' has contradictory durable boundary identity.`,
            'CONFLICT',
            {
              operationId,
              capsuleId,
              sourceBranchId: branch.id,
              artifactRootId: mount.artifactRootId,
              resourceId: resource.id,
              expectedNamespace,
              actualNamespace: metadata.namespace,
              expectedLogicalPath: mount.logicalPath,
              actualMountPath: metadata.mountPath,
              readonly: metadata.readonly,
              expectedResourceKey,
              actualResourceKey: resource.resourceKey,
            },
          )
        }

        return {
          artifactRootId: mount.artifactRootId,
          blueprintVolumeName: mount.blueprintVolumeName,
          sourceBranchResourceId: resource.id,
          kind: mount.dependency.kind,
          logicalId: mount.dependency.logicalId,
          required: mount.required,
          logicalPath: mount.logicalPath,
        }
      })
      .sort((left, right) => compareStableString(left.blueprintVolumeName, right.blueprintVolumeName))

    return {
      roots,
      dependencies,
    }
  }

  /**
   * Verifies that operation-scoped provider snapshot accounting exactly matches
   * the deterministic plan and remains untouched before provider intent.
   */
  public assertResources(operationId: string, plan: CapturePlan, resources: readonly CaptureResourceRecord[]): void {
    if (resources.length !== plan.roots.length) {
      throw new IncusError('Snapshot Capture provider resource accounting is incomplete.', 'CONFLICT', {
        operationId,
        expectedResourceCount: plan.roots.length,
        actualResourceCount: resources.length,
      })
    }

    const resourcesByRoot = new Map(resources.map(resource => [resource.artifactRootId, resource] as const))

    for (const root of plan.roots) {
      const resource = resourcesByRoot.get(root.artifactRootId)
      if (!resource) {
        throw new IncusError(
          `Snapshot Capture provider accounting is missing artifact root '${root.artifactRootId}'.`,
          'CONFLICT',
          {
            operationId,
            artifactRootId: root.artifactRootId,
          },
        )
      }

      if (
        resource.operationId !== operationId ||
        resource.sourceBranchResourceId !== root.sourceBranchResourceId ||
        resource.blueprintVolumeName !== root.blueprintVolumeName ||
        resource.provider !== root.provider ||
        resource.kind !== root.kind ||
        resource.project !== root.project ||
        resource.pool !== root.pool ||
        resource.sourceVolume !== root.sourceVolume ||
        resource.snapshotName !== root.snapshotName ||
        resource.status !== 'planned' ||
        resource.snapshotIntentAt !== null ||
        resource.snapshotCreatedAt !== null ||
        resource.cleanupIntentAt !== null ||
        resource.cleanupCompletedAt !== null ||
        resource.failureCode !== null ||
        resource.failureMessage !== null ||
        resource.failureDetails !== null ||
        resource.failureAt !== null
      ) {
        throw new IncusError(
          `Snapshot Capture provider accounting for artifact root '${root.artifactRootId}' is not in its immutable pre-provider state.`,
          'CONFLICT',
          {
            operationId,
            artifactRootId: root.artifactRootId,
            captureResourceId: resource.id,
            captureResourceStatus: resource.status,
          },
        )
      }
    }
  }

  private assertResourceOwnership(
    operationId: string,
    ownerId: string,
    branch: CaptureSourceBranch,
    resources: readonly CapsuleBranchResourceInventoryRow[],
  ): void {
    for (const resource of resources) {
      if (
        resource.ownerId !== ownerId ||
        resource.branchId !== branch.id ||
        resource.branchName !== branch.name ||
        resource.createdByOperationId === null
      ) {
        throw new IncusError(
          'Snapshot Capture source branch inventory contains foreign, detached, or unproven resource evidence.',
          'CONFLICT',
          {
            operationId,
            sourceBranchId: branch.id,
            resourceId: resource.id,
            resourceOwnerId: resource.ownerId,
            resourceBranchId: resource.branchId,
            resourceBranchName: resource.branchName,
            createdByOperationId: resource.createdByOperationId,
          },
        )
      }
    }
  }

  private snapshotName(operationId: string, artifactRootId: string): string {
    const name = `qiln-${operationId}-${artifactRootId}`
    if (name.length > 255) {
      throw new IncusError(
        'Generated Snapshot Capture provider snapshot name exceeds the supported identity limit.',
        'VALIDATION_ERROR',
        {
          operationId,
          artifactRootId,
          length: name.length,
        },
      )
    }
    return name
  }
}
