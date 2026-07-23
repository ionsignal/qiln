import {
  CapsuleBranchResourceCleanupPolicy,
  CapsuleBranchResourceStatus,
  CapsuleBranchResourceType,
  type CapsuleBranchResourceStatusValue,
} from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import { instanceResourceKey, volumeResourceKey } from '../../../resource/identity'
import { assertCapsuleBranchResourceInventoryMatches } from '../../../resource/inventory'
import {
  parseBindMountResourceMetadata,
  parseInstanceResourceMetadata,
  parseProjectResourceMetadata,
  parseProvisioningFileResourceMetadata,
  parseVolumeResourceMetadata,
} from '../../../resource/metadata'
import { assertDestroyingCapsuleBranchLineage } from '../policy/lineage'
import type { CapsuleBranchResourceInventoryRow } from '../../../resource/types'
import type {
  DestroyCapsuleAcceptedBranch,
  DestroyCapsuleBindMountResource,
  DestroyCapsuleBranchPlan,
  DestroyCapsuleInstanceTarget,
  DestroyCapsulePlan,
  DestroyCapsulePlanSummary,
  DestroyCapsuleProjectResource,
  DestroyCapsuleProvisioningFileResource,
  DestroyCapsuleVolumeTarget,
} from '../types'

type DestroyInventoryValidation =
  | {
      phase: 'deletion_ready'
    }
  | {
      phase: 'terminal'
      operationId: string
    }

function compareStableString(left: string, right: string): number {
  if (left < right) {
    return -1
  }

  if (left > right) {
    return 1
  }

  return 0
}

function requireSingleResource<TResource>(
  resources: readonly TResource[],
  message: string,
  details: Record<string, unknown>,
): TResource {
  if (resources.length !== 1) {
    throw new IncusError(message, 'CONFLICT', {
      ...details,
      resourceCount: resources.length,
    })
  }

  return resources[0]!
}

/**
 * Builds and validates fail-closed destroy ownership evidence exclusively from
 * durable Qiln inventory.
 *
 * Live Incus state is never used to discover ownership. Provider reads and
 * mutations are permitted only after `createPlan()` has selected deletion
 * targets from a complete, digest-verified branch inventory.
 *
 * `assertTerminalResourceOutcomes()` applies the same topology and ownership
 * proof to terminal persistence state. It additionally requires each managed or
 * derived resource outcome to have been last touched by the completing destroy
 * operation.
 */
export class DestroyCapsulePlanner {
  /**
   * Produces the deterministic provider deletion plan from deletion-ready
   * durable inventory.
   */
  public createPlan(
    ownerId: string,
    capsuleId: string,
    branches: readonly DestroyCapsuleAcceptedBranch[],
    resourceRows: readonly CapsuleBranchResourceInventoryRow[],
  ): DestroyCapsulePlan {
    return this.createValidatedPlan(ownerId, capsuleId, branches, resourceRows, {
      phase: 'deletion_ready',
    })
  }

  /**
   * Proves that the complete durable resource inventory reached terminal
   * outcomes under one specific destroy operation.
   *
   * This method does not trust or consume a process-local plan. It reconstructs
   * branch resource topology from the supplied durable branch and resource
   * rows, verifies every inventory digest, and checks operation provenance for
   * all destructive outcomes.
   *
   * Completion must call this with rows locked inside its terminal transaction.
   * The executor may also call it as an earlier diagnostic preflight.
   */
  public assertTerminalResourceOutcomes(
    ownerId: string,
    capsuleId: string,
    branches: readonly DestroyCapsuleAcceptedBranch[],
    resourceRows: readonly CapsuleBranchResourceInventoryRow[],
    operationId: string,
  ): void {
    if (operationId.trim() === '') {
      throw new IncusError(
        'Capsule destroy terminal verification requires a durable operation identity.',
        'VALIDATION_ERROR',
        {
          ownerId,
          capsuleId,
        },
      )
    }
    this.createValidatedPlan(ownerId, capsuleId, branches, resourceRows, {
      phase: 'terminal',
      operationId,
    })
  }

  public summarize(plan: DestroyCapsulePlan): DestroyCapsulePlanSummary {
    return {
      branchCount: plan.branches.length,
      instanceCount: plan.instances.length,
      volumeCount: plan.volumes.length,
      provisioningFileCount: plan.provisioningFiles.length,
    }
  }

  private createValidatedPlan(
    ownerId: string,
    capsuleId: string,
    branches: readonly DestroyCapsuleAcceptedBranch[],
    resourceRows: readonly CapsuleBranchResourceInventoryRow[],
    validation: DestroyInventoryValidation,
  ): DestroyCapsulePlan {
    assertDestroyingCapsuleBranchLineage(ownerId, capsuleId, branches)

    const branchIds = new Set(branches.map(branch => branch.id))
    const rowsByBranch = new Map<string, CapsuleBranchResourceInventoryRow[]>()
    for (const row of resourceRows) {
      if (row.branchId === null || !branchIds.has(row.branchId)) {
        throw new IncusError(
          'Capsule destroy resource inventory contains a foreign or detached resource.',
          'CONFLICT',
          {
            capsuleId,
            resourceId: row.id,
            branchId: row.branchId,
            resourceKey: row.resourceKey,
            validationPhase: validation.phase,
          },
        )
      }
      if (row.createdByOperationId === null) {
        throw new IncusError('Capsule destroy resource has no durable creation provenance.', 'CONFLICT', {
          capsuleId,
          resourceId: row.id,
          branchId: row.branchId,
          resourceKey: row.resourceKey,
          validationPhase: validation.phase,
        })
      }

      this.assertBlueprintVolumeIdentity(row, validation)

      const rows = rowsByBranch.get(row.branchId) ?? []
      rows.push(row)
      rowsByBranch.set(row.branchId, rows)
    }
    const branchPlans = [...branches]
      .sort((left, right) => compareStableString(left.id, right.id))
      .map(branch => this.createBranchPlan(ownerId, branch, rowsByBranch.get(branch.id) ?? [], validation))
    const instances = branchPlans
      .map(plan => plan.instance)
      .sort((left, right) => compareStableString(left.resourceKey, right.resourceKey))
    const volumes = branchPlans
      .flatMap(plan => plan.volumes)
      .sort((left, right) => compareStableString(left.resourceKey, right.resourceKey))
    const provisioningFiles = branchPlans
      .flatMap(plan => plan.provisioningFiles)
      .sort((left, right) => compareStableString(left.resourceKey, right.resourceKey))

    this.assertUniqueManagedProviderIdentities(instances, volumes)
    return {
      ownerId,
      capsuleId,
      branches: branchPlans,
      instances,
      volumes,
      provisioningFiles,
      resourceIds: new Set(resourceRows.map(row => row.id)),
    }
  }

  private createBranchPlan(
    ownerId: string,
    branch: DestroyCapsuleAcceptedBranch,
    rows: readonly CapsuleBranchResourceInventoryRow[],
    validation: DestroyInventoryValidation,
  ): DestroyCapsuleBranchPlan {
    if (branch.resourceInventoryDigest === null) {
      throw new IncusError(
        'Capsule branch has no durable resource inventory proof. Manual review is required.',
        'CONFLICT',
        {
          capsuleId: branch.capsuleId,
          branchId: branch.id,
          branchName: branch.name,
          validationPhase: validation.phase,
        },
      )
    }
    for (const row of rows) {
      if (
        row.ownerId !== ownerId ||
        row.branchId !== branch.id ||
        row.branchName !== branch.name ||
        row.provider !== 'incus'
      ) {
        throw new IncusError(
          'Capsule branch resource identity does not match its accepted destroy branch.',
          'CONFLICT',
          {
            capsuleId: branch.capsuleId,
            branchId: branch.id,
            branchName: branch.name,
            resourceId: row.id,
            resourceOwnerId: row.ownerId,
            resourceBranchId: row.branchId,
            resourceBranchName: row.branchName,
            provider: row.provider,
            validationPhase: validation.phase,
          },
        )
      }
    }

    assertCapsuleBranchResourceInventoryMatches(
      branch.resourceInventoryDigest,
      rows.map(row => ({
        provider: row.provider,
        resourceType: row.resourceType,
        resourceKey: row.resourceKey,
        blueprintVolumeName: row.blueprintVolumeName,
        cleanupPolicy: row.cleanupPolicy,
        metadata: row.metadata,
      })),
    )

    const projects: DestroyCapsuleProjectResource[] = []
    const bindMounts: DestroyCapsuleBindMountResource[] = []
    const instances: DestroyCapsuleInstanceTarget[] = []
    const volumes: DestroyCapsuleVolumeTarget[] = []
    const rawProvisioningFiles: Array<{
      row: CapsuleBranchResourceInventoryRow
      metadata: ReturnType<typeof parseProvisioningFileResourceMetadata>
    }> = []
    for (const row of rows) {
      switch (row.resourceType) {
        case CapsuleBranchResourceType.INCUS_PROJECT: {
          this.assertResourceState(
            row,
            CapsuleBranchResourceCleanupPolicy.RETAIN,
            [CapsuleBranchResourceStatus.ADOPTED],
            validation,
            false,
          )
          projects.push({
            kind: 'project',
            id: row.id,
            branchId: branch.id,
            branchName: branch.name,
            resourceKey: row.resourceKey,
            status: row.status,
            metadata: parseProjectResourceMetadata(row.metadata),
          })
          break
        }

        case CapsuleBranchResourceType.BIND_MOUNT: {
          this.assertResourceState(
            row,
            CapsuleBranchResourceCleanupPolicy.EXTERNAL,
            [CapsuleBranchResourceStatus.ADOPTED],
            validation,
            false,
          )
          bindMounts.push({
            kind: 'bindMount',
            id: row.id,
            branchId: branch.id,
            branchName: branch.name,
            resourceKey: row.resourceKey,
            status: row.status,
            metadata: parseBindMountResourceMetadata(row.metadata),
          })
          break
        }

        case CapsuleBranchResourceType.INCUS_INSTANCE: {
          this.assertResourceState(
            row,
            CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH,
            validation.phase === 'deletion_ready'
              ? [CapsuleBranchResourceStatus.CREATED]
              : [CapsuleBranchResourceStatus.DELETED, CapsuleBranchResourceStatus.MISSING],
            validation,
            true,
          )
          const metadata = parseInstanceResourceMetadata(row.metadata)
          instances.push({
            kind: 'instance',
            id: row.id,
            branchId: branch.id,
            branchName: branch.name,
            resourceKey: row.resourceKey,
            status: row.status,
            namespace: metadata.namespace,
            instanceName: metadata.instanceName,
            metadata,
          })
          break
        }
        case CapsuleBranchResourceType.ZFS_VOLUME: {
          this.assertResourceState(
            row,
            CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH,
            validation.phase === 'deletion_ready'
              ? [CapsuleBranchResourceStatus.CREATED]
              : [CapsuleBranchResourceStatus.DELETED, CapsuleBranchResourceStatus.MISSING],
            validation,
            true,
          )
          const metadata = parseVolumeResourceMetadata(row.metadata)
          volumes.push({
            kind: 'volume',
            id: row.id,
            branchId: branch.id,
            branchName: branch.name,
            resourceKey: row.resourceKey,
            status: row.status,
            namespace: metadata.namespace,
            pool: metadata.pool,
            volumeName: metadata.volumeName,
            metadata,
          })
          break
        }
        case CapsuleBranchResourceType.PROVISIONING_FILE: {
          this.assertResourceState(
            row,
            CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH,
            validation.phase === 'deletion_ready'
              ? [CapsuleBranchResourceStatus.CREATED]
              : [CapsuleBranchResourceStatus.DELETED],
            validation,
            true,
          )
          rawProvisioningFiles.push({
            row,
            metadata: parseProvisioningFileResourceMetadata(row.metadata),
          })
          break
        }
        default: {
          this.rejectUnsupportedResourceType(row, branch, validation)
        }
      }
    }
    const project = requireSingleResource(
      projects,
      'Capsule branch destroy inventory must contain exactly one retained project.',
      {
        capsuleId: branch.capsuleId,
        branchId: branch.id,
        branchName: branch.name,
        validationPhase: validation.phase,
      },
    )
    const instance = requireSingleResource(
      instances,
      'Capsule branch destroy inventory must contain exactly one managed instance.',
      {
        capsuleId: branch.capsuleId,
        branchId: branch.id,
        branchName: branch.name,
        validationPhase: validation.phase,
      },
    )
    const expectedNamespace = `user-${ownerId}`
    if (project.metadata.namespace !== expectedNamespace || instance.namespace !== expectedNamespace) {
      throw new IncusError('Capsule branch resource namespace does not match its owner namespace.', 'CONFLICT', {
        capsuleId: branch.capsuleId,
        branchId: branch.id,
        expectedNamespace,
        projectNamespace: project.metadata.namespace,
        instanceNamespace: instance.namespace,
        validationPhase: validation.phase,
      })
    }
    if (instance.instanceName !== branch.name) {
      throw new IncusError(
        'Capsule branch managed instance identity does not match the durable branch name.',
        'CONFLICT',
        {
          capsuleId: branch.capsuleId,
          branchId: branch.id,
          branchName: branch.name,
          instanceName: instance.instanceName,
          validationPhase: validation.phase,
        },
      )
    }
    for (const bindMount of bindMounts) {
      if (bindMount.metadata.namespace !== expectedNamespace) {
        throw new IncusError('Capsule branch bind-mount namespace does not match its owner namespace.', 'CONFLICT', {
          capsuleId: branch.capsuleId,
          branchId: branch.id,
          resourceId: bindMount.id,
          expectedNamespace,
          actualNamespace: bindMount.metadata.namespace,
          validationPhase: validation.phase,
        })
      }
    }
    for (const volume of volumes) {
      if (volume.namespace !== expectedNamespace) {
        throw new IncusError('Capsule branch volume namespace does not match its owner namespace.', 'CONFLICT', {
          capsuleId: branch.capsuleId,
          branchId: branch.id,
          resourceId: volume.id,
          expectedNamespace,
          actualNamespace: volume.namespace,
          validationPhase: validation.phase,
        })
      }
    }
    const directResourcesByKey = new Map<string, string>([
      [instanceResourceKey(instance.namespace, instance.instanceName), instance.id],
      ...volumes.map(
        volume => [volumeResourceKey(volume.namespace, volume.pool, volume.volumeName), volume.id] as const,
      ),
    ])
    const provisioningFiles: DestroyCapsuleProvisioningFileResource[] = rawProvisioningFiles.map(
      ({ row, metadata }) => {
        if (metadata.namespace !== expectedNamespace || metadata.branchName !== branch.name) {
          throw new IncusError('Provisioning-file metadata does not match its capsule branch identity.', 'CONFLICT', {
            capsuleId: branch.capsuleId,
            branchId: branch.id,
            resourceId: row.id,
            expectedNamespace,
            actualNamespace: metadata.namespace,
            expectedBranchName: branch.name,
            actualBranchName: metadata.branchName,
            validationPhase: validation.phase,
          })
        }
        const backingResourceKey =
          metadata.target === 'instance'
            ? instanceResourceKey(metadata.namespace, metadata.branchName)
            : volumeResourceKey(metadata.namespace, metadata.pool, metadata.volumeName)
        const backingResourceId = directResourcesByKey.get(backingResourceKey)
        if (!backingResourceId) {
          throw new IncusError('Provisioning-file resource has no proven managed backing resource.', 'CONFLICT', {
            capsuleId: branch.capsuleId,
            branchId: branch.id,
            resourceId: row.id,
            resourceKey: row.resourceKey,
            backingResourceKey,
            validationPhase: validation.phase,
          })
        }
        return {
          kind: 'provisioningFile',
          id: row.id,
          branchId: branch.id,
          branchName: branch.name,
          resourceKey: row.resourceKey,
          status: row.status,
          backingResourceId,
          metadata,
        }
      },
    )
    return {
      branch,
      project,
      bindMounts: bindMounts.sort((left, right) => compareStableString(left.resourceKey, right.resourceKey)),
      instance,
      volumes: volumes.sort((left, right) => compareStableString(left.resourceKey, right.resourceKey)),
      provisioningFiles: provisioningFiles.sort((left, right) =>
        compareStableString(left.resourceKey, right.resourceKey),
      ),
    }
  }

  private assertBlueprintVolumeIdentity(
    row: CapsuleBranchResourceInventoryRow,
    validation: DestroyInventoryValidation,
  ): void {
    const requiresBlueprintVolumeName =
      row.resourceType === CapsuleBranchResourceType.ZFS_VOLUME ||
      row.resourceType === CapsuleBranchResourceType.BIND_MOUNT
    if (requiresBlueprintVolumeName && row.blueprintVolumeName === null) {
      throw new IncusError(
        'Managed volume or bind-mount resource has no durable blueprint volume identity.',
        'CONFLICT',
        {
          resourceId: row.id,
          resourceType: row.resourceType,
          resourceKey: row.resourceKey,
          validationPhase: validation.phase,
        },
      )
    }
    if (!requiresBlueprintVolumeName && row.blueprintVolumeName !== null) {
      throw new IncusError('Capsule branch resource retains an invalid blueprint volume identity.', 'CONFLICT', {
        resourceId: row.id,
        resourceType: row.resourceType,
        resourceKey: row.resourceKey,
        blueprintVolumeName: row.blueprintVolumeName,
        validationPhase: validation.phase,
      })
    }
  }

  private assertResourceState(
    row: CapsuleBranchResourceInventoryRow,
    expectedCleanupPolicy: CapsuleBranchResourceInventoryRow['cleanupPolicy'],
    allowedStatuses: readonly CapsuleBranchResourceStatusValue[],
    validation: DestroyInventoryValidation,
    requireDestroyOperationProvenance: boolean,
  ): void {
    if (row.cleanupPolicy !== expectedCleanupPolicy || !allowedStatuses.includes(row.status)) {
      throw new IncusError(
        'Capsule branch resource is not eligible under its durable destroy policy and status.',
        'CONFLICT',
        {
          resourceId: row.id,
          resourceKey: row.resourceKey,
          resourceType: row.resourceType,
          expectedCleanupPolicy,
          actualCleanupPolicy: row.cleanupPolicy,
          allowedStatuses,
          actualStatus: row.status,
          validationPhase: validation.phase,
        },
      )
    }
    if (
      validation.phase === 'terminal' &&
      requireDestroyOperationProvenance &&
      row.lastOperationId !== validation.operationId
    ) {
      throw new IncusError(
        'Capsule branch terminal resource outcome was not committed by the completing destroy operation.',
        'CONFLICT',
        {
          operationId: validation.operationId,
          resourceId: row.id,
          resourceKey: row.resourceKey,
          resourceType: row.resourceType,
          resourceStatus: row.status,
          lastOperationId: row.lastOperationId,
        },
      )
    }
  }

  private rejectUnsupportedResourceType(
    row: CapsuleBranchResourceInventoryRow,
    branch: DestroyCapsuleAcceptedBranch,
    validation: DestroyInventoryValidation,
  ): never {
    throw new IncusError('Capsule branch resource type is unsupported by fail-closed destroy planning.', 'CONFLICT', {
      capsuleId: branch.capsuleId,
      branchId: branch.id,
      branchName: branch.name,
      resourceId: row.id,
      resourceKey: row.resourceKey,
      resourceType: row.resourceType,
      validationPhase: validation.phase,
    })
  }

  private assertUniqueManagedProviderIdentities(
    instances: readonly DestroyCapsuleInstanceTarget[],
    volumes: readonly DestroyCapsuleVolumeTarget[],
  ): void {
    const identities = new Set<string>()
    for (const instance of instances) {
      const identity = `instance\u0000${instance.namespace}\u0000${instance.instanceName}`
      if (identities.has(identity)) {
        throw new IncusError('Capsule destroy plan contains a duplicate managed instance identity.', 'CONFLICT', {
          namespace: instance.namespace,
          instanceName: instance.instanceName,
          resourceId: instance.id,
        })
      }
      identities.add(identity)
    }
    for (const volume of volumes) {
      const identity = `volume\u0000${volume.namespace}\u0000${volume.pool}\u0000${volume.volumeName}`
      if (identities.has(identity)) {
        throw new IncusError('Capsule destroy plan contains a duplicate managed volume identity.', 'CONFLICT', {
          namespace: volume.namespace,
          pool: volume.pool,
          volumeName: volume.volumeName,
          resourceId: volume.id,
        })
      }
      identities.add(identity)
    }
  }
}
