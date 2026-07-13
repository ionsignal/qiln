import { CapsuleBranchResourceCleanupPolicy, CapsuleBranchResourceStatus, CapsuleBranchResourceType } from '@qiln/core/server'
import { IncusError } from '../../../../errors'
import { instanceResourceKey, volumeResourceKey } from '../../resources/identity'
import { assertCapsuleBranchResourceInventoryMatches } from '../../resources/inventory'
import {
  parseBindMountResourceMetadata,
  parseInstanceResourceMetadata,
  parseProjectResourceMetadata,
  parseProvisioningFileResourceMetadata,
  parseVolumeResourceMetadata,
} from '../../resources/metadata'
import type { CapsuleBranchResourceInventoryRow } from '../../stores/types'
import type {
  CapsuleDestroyAcceptedBranch,
  CapsuleDestroyBindMountResource,
  CapsuleDestroyBranchPlan,
  CapsuleDestroyInstanceTarget,
  CapsuleDestroyPlan,
  CapsuleDestroyPlanSummary,
  CapsuleDestroyProjectResource,
  CapsuleDestroyProvisioningFileResource,
  CapsuleDestroyVolumeTarget,
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

function requireSingleResource<TResource>(resources: readonly TResource[], message: string, details: Record<string, unknown>): TResource {
  if (resources.length !== 1) {
    throw new IncusError(message, 'CONFLICT', {
      ...details,
      resourceCount: resources.length,
    })
  }
  return resources[0]!
}

/**
 * Builds a fail-closed capsule-wide destroy plan exclusively from durable branch and resource inventory.
 *
 * Live Incus state is never used to discover ownership. Provider reads become permissible only after this
 * planner has proven the complete durable inventory.
 */
export class CapsuleDestroyPlanner {
  public createPlan(
    ownerId: string,
    capsuleId: string,
    branches: readonly CapsuleDestroyAcceptedBranch[],
    resourceRows: readonly CapsuleBranchResourceInventoryRow[],
  ): CapsuleDestroyPlan {
    if (branches.length === 0) {
      throw new IncusError('Capsule destroy requires at least one durable branch.', 'CONFLICT', {
        ownerId,
        capsuleId,
      })
    }
    const rootBranches = branches.filter(branch => branch.isRootBranch)
    if (rootBranches.length !== 1) {
      throw new IncusError('Capsule destroy requires exactly one durable root branch.', 'CONFLICT', {
        ownerId,
        capsuleId,
        branchCount: branches.length,
        rootBranchCount: rootBranches.length,
      })
    }
    const branchIds = new Set<string>()
    for (const branch of branches) {
      if (branch.ownerId !== ownerId || branch.capsuleId !== capsuleId) {
        throw new IncusError('Capsule destroy branch identity does not match the accepted aggregate.', 'CONFLICT', {
          ownerId,
          capsuleId,
          branchId: branch.id,
          branchOwnerId: branch.ownerId,
          branchCapsuleId: branch.capsuleId,
        })
      }
      if (branch.status !== 'destroying') {
        throw new IncusError('Capsule destroy planning requires every accepted branch to remain destroying.', 'CONFLICT', {
          capsuleId,
          branchId: branch.id,
          branchName: branch.name,
          branchStatus: branch.status,
        })
      }
      if (branchIds.has(branch.id)) {
        throw new IncusError('Capsule destroy contains a duplicate branch identity.', 'CONFLICT', {
          capsuleId,
          branchId: branch.id,
        })
      }
      branchIds.add(branch.id)
    }
    const rowsByBranch = new Map<string, CapsuleBranchResourceInventoryRow[]>()
    for (const row of resourceRows) {
      if (row.branchId === null || !branchIds.has(row.branchId)) {
        throw new IncusError('Capsule destroy resource inventory contains a foreign or detached resource.', 'CONFLICT', {
          capsuleId,
          resourceId: row.id,
          branchId: row.branchId,
          resourceKey: row.resourceKey,
        })
      }
      const rows = rowsByBranch.get(row.branchId) ?? []
      rows.push(row)
      rowsByBranch.set(row.branchId, rows)
    }
    const branchPlans = [...branches]
      .sort((left, right) => compareStableString(left.id, right.id))
      .map(branch => this.createBranchPlan(ownerId, branch, rowsByBranch.get(branch.id) ?? []))
    const instances = branchPlans.map(plan => plan.instance).sort((left, right) => compareStableString(left.resourceKey, right.resourceKey))
    const volumes = branchPlans.flatMap(plan => plan.volumes).sort((left, right) => compareStableString(left.resourceKey, right.resourceKey))
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

  public verifyTerminalOutcomes(plan: CapsuleDestroyPlan, rows: readonly CapsuleBranchResourceInventoryRow[]): void {
    if (rows.length !== plan.resourceIds.size) {
      throw new IncusError('Capsule destroy terminal resource inventory count changed after planning.', 'CONFLICT', {
        capsuleId: plan.capsuleId,
        expectedResourceCount: plan.resourceIds.size,
        actualResourceCount: rows.length,
      })
    }
    const rowsById = new Map(rows.map(row => [row.id, row]))
    for (const resourceId of plan.resourceIds) {
      if (!rowsById.has(resourceId)) {
        throw new IncusError('Capsule destroy terminal verification is missing a planned resource.', 'CONFLICT', {
          capsuleId: plan.capsuleId,
          resourceId,
        })
      }
    }
    for (const branchPlan of plan.branches) {
      this.requireStatus(
        rowsById,
        branchPlan.project.id,
        [CapsuleBranchResourceStatus.ADOPTED],
        'Retained capsule project resource changed during destroy.',
      )
      for (const bindMount of branchPlan.bindMounts) {
        this.requireStatus(
          rowsById,
          bindMount.id,
          [CapsuleBranchResourceStatus.ADOPTED],
          'External capsule bind-mount resource changed during destroy.',
        )
      }
    }
    for (const target of [...plan.instances, ...plan.volumes]) {
      this.requireStatus(
        rowsById,
        target.id,
        [CapsuleBranchResourceStatus.DELETED, CapsuleBranchResourceStatus.MISSING],
        'Managed capsule resource did not reach a terminal destroy outcome.',
      )
    }
    for (const file of plan.provisioningFiles) {
      this.requireStatus(
        rowsById,
        file.id,
        [CapsuleBranchResourceStatus.DELETED],
        'Derived provisioning-file resource did not reach its terminal destroy outcome.',
      )
    }
  }

  public summarize(plan: CapsuleDestroyPlan): CapsuleDestroyPlanSummary {
    return {
      branchCount: plan.branches.length,
      instanceCount: plan.instances.length,
      volumeCount: plan.volumes.length,
      provisioningFileCount: plan.provisioningFiles.length,
    }
  }

  private createBranchPlan(
    ownerId: string,
    branch: CapsuleDestroyAcceptedBranch,
    rows: readonly CapsuleBranchResourceInventoryRow[],
  ): CapsuleDestroyBranchPlan {
    if (branch.resourceInventoryDigest === null) {
      throw new IncusError('Capsule branch has no durable resource inventory proof. Manual review is required.', 'CONFLICT', {
        capsuleId: branch.capsuleId,
        branchId: branch.id,
        branchName: branch.name,
      })
    }
    for (const row of rows) {
      if (row.ownerId !== ownerId || row.branchId !== branch.id || row.branchName !== branch.name || row.provider !== 'incus') {
        throw new IncusError('Capsule branch resource identity does not match its accepted destroy branch.', 'CONFLICT', {
          capsuleId: branch.capsuleId,
          branchId: branch.id,
          branchName: branch.name,
          resourceId: row.id,
          resourceOwnerId: row.ownerId,
          resourceBranchId: row.branchId,
          resourceBranchName: row.branchName,
          provider: row.provider,
        })
      }
    }
    assertCapsuleBranchResourceInventoryMatches(
      branch.resourceInventoryDigest,
      rows.map(row => ({
        provider: row.provider,
        resourceType: row.resourceType,
        resourceKey: row.resourceKey,
        cleanupPolicy: row.cleanupPolicy,
        metadata: row.metadata,
      })),
    )
    const projects: CapsuleDestroyProjectResource[] = []
    const bindMounts: CapsuleDestroyBindMountResource[] = []
    const instances: CapsuleDestroyInstanceTarget[] = []
    const volumes: CapsuleDestroyVolumeTarget[] = []
    const rawProvisioningFiles: Array<{
      row: CapsuleBranchResourceInventoryRow
      metadata: ReturnType<typeof parseProvisioningFileResourceMetadata>
    }> = []
    for (const row of rows) {
      switch (row.resourceType) {
        case CapsuleBranchResourceType.INCUS_PROJECT: {
          this.assertResourcePolicyAndStatus(row, CapsuleBranchResourceCleanupPolicy.RETAIN, CapsuleBranchResourceStatus.ADOPTED)
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
          this.assertResourcePolicyAndStatus(row, CapsuleBranchResourceCleanupPolicy.EXTERNAL, CapsuleBranchResourceStatus.ADOPTED)
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
          this.assertResourcePolicyAndStatus(row, CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH, CapsuleBranchResourceStatus.CREATED)
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
          this.assertResourcePolicyAndStatus(row, CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH, CapsuleBranchResourceStatus.CREATED)
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
          this.assertResourcePolicyAndStatus(row, CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH, CapsuleBranchResourceStatus.CREATED)
          rawProvisioningFiles.push({
            row,
            metadata: parseProvisioningFileResourceMetadata(row.metadata),
          })
          break
        }
      }
    }
    const project = requireSingleResource(projects, 'Capsule branch destroy inventory must contain exactly one retained project.', {
      capsuleId: branch.capsuleId,
      branchId: branch.id,
      branchName: branch.name,
    })
    const instance = requireSingleResource(instances, 'Capsule branch destroy inventory must contain exactly one managed instance.', {
      capsuleId: branch.capsuleId,
      branchId: branch.id,
      branchName: branch.name,
    })
    const expectedNamespace = `user-${ownerId}`
    if (project.metadata.namespace !== expectedNamespace || instance.namespace !== expectedNamespace) {
      throw new IncusError('Capsule branch resource namespace does not match its owner namespace.', 'CONFLICT', {
        capsuleId: branch.capsuleId,
        branchId: branch.id,
        expectedNamespace,
        projectNamespace: project.metadata.namespace,
        instanceNamespace: instance.namespace,
      })
    }
    if (instance.instanceName !== branch.name) {
      throw new IncusError('Capsule branch managed instance identity does not match the durable branch name.', 'CONFLICT', {
        capsuleId: branch.capsuleId,
        branchId: branch.id,
        branchName: branch.name,
        instanceName: instance.instanceName,
      })
    }
    for (const bindMount of bindMounts) {
      if (bindMount.metadata.namespace !== expectedNamespace) {
        throw new IncusError('Capsule branch bind-mount namespace does not match its owner namespace.', 'CONFLICT', {
          capsuleId: branch.capsuleId,
          branchId: branch.id,
          resourceId: bindMount.id,
          expectedNamespace,
          actualNamespace: bindMount.metadata.namespace,
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
        })
      }
    }
    const directResourcesByKey = new Map<string, string>([
      [instanceResourceKey(instance.namespace, instance.instanceName), instance.id],
      ...volumes.map(volume => [volumeResourceKey(volume.namespace, volume.pool, volume.volumeName), volume.id] as const),
    ])
    const provisioningFiles: CapsuleDestroyProvisioningFileResource[] = rawProvisioningFiles.map(({ row, metadata }) => {
      if (metadata.namespace !== expectedNamespace || metadata.branchName !== branch.name) {
        throw new IncusError('Provisioning-file metadata does not match its capsule branch identity.', 'CONFLICT', {
          capsuleId: branch.capsuleId,
          branchId: branch.id,
          resourceId: row.id,
          expectedNamespace,
          actualNamespace: metadata.namespace,
          expectedBranchName: branch.name,
          actualBranchName: metadata.branchName,
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
    })
    return {
      branch,
      project,
      bindMounts: bindMounts.sort((left, right) => compareStableString(left.resourceKey, right.resourceKey)),
      instance,
      volumes: volumes.sort((left, right) => compareStableString(left.resourceKey, right.resourceKey)),
      provisioningFiles: provisioningFiles.sort((left, right) => compareStableString(left.resourceKey, right.resourceKey)),
    }
  }

  private assertResourcePolicyAndStatus(
    row: CapsuleBranchResourceInventoryRow,
    expectedCleanupPolicy: CapsuleBranchResourceInventoryRow['cleanupPolicy'],
    expectedStatus: CapsuleBranchResourceInventoryRow['status'],
  ): void {
    if (row.cleanupPolicy !== expectedCleanupPolicy || row.status !== expectedStatus) {
      throw new IncusError('Capsule branch resource is not eligible for destroy under its durable policy and status.', 'CONFLICT', {
        resourceId: row.id,
        resourceKey: row.resourceKey,
        resourceType: row.resourceType,
        expectedCleanupPolicy,
        actualCleanupPolicy: row.cleanupPolicy,
        expectedStatus,
        actualStatus: row.status,
      })
    }
  }

  private assertUniqueManagedProviderIdentities(
    instances: readonly CapsuleDestroyInstanceTarget[],
    volumes: readonly CapsuleDestroyVolumeTarget[],
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

  private requireStatus(
    rowsById: ReadonlyMap<string, CapsuleBranchResourceInventoryRow>,
    resourceId: string,
    allowedStatuses: readonly CapsuleBranchResourceInventoryRow['status'][],
    message: string,
  ): void {
    const row = rowsById.get(resourceId)
    if (!row || !allowedStatuses.includes(row.status)) {
      throw new IncusError(message, 'CONFLICT', {
        resourceId,
        actualStatus: row?.status ?? null,
        allowedStatuses,
      })
    }
  }
}
