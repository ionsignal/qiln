import { CapsuleBranchResourceInventoryDigestSchema, type CapsuleTables } from '@qiln/core/server'
import { IncusError } from '../../../../errors'
import { sameRootfs } from '../shared/rootfs'
import { assertCapsuleBranchResourceInventoryMatches } from '../../resource/inventory'
import {
  bindMountResourceKey,
  branchInstanceName,
  instanceResourceKey,
  projectResourceKey,
  volumeResourceKey,
} from '../../resource/identity'
import {
  parseBindMountResourceMetadata,
  parseInstanceResourceMetadata,
  parseProjectResourceMetadata,
  parseVolumeResourceMetadata,
} from '../../resource/metadata'
import type { CapsuleBranchProvenancePins } from '../../branch/provenance'
import type { SnapshotPlan, SnapshotResource, SnapshotVolume } from './types'

export interface SnapshotPlanInput {
  operationId: string
  branch: CapsuleTables['capsuleBranches']['$inferSelect']
  provenance: CapsuleBranchProvenancePins
  resources: readonly CapsuleTables['capsuleBranchResources']['$inferSelect'][]
}

function conflict(operationId: string, message: string): never {
  throw new IncusError(message, 'CONFLICT', {
    operationId,
  })
}

/**
 * Proves the complete source inventory and selects every managed Blueprint
 * volume without artifact roots or filesystem inspection.
 *
 * Bind records are checked as existing branch configuration, but never become
 * provider snapshot plans or committed snapshot references.
 */
export class SnapshotPlanner {
  public create(input: SnapshotPlanInput): SnapshotPlan {
    const { operationId, branch, provenance, resources } = input
    const blueprint = provenance.blueprint.blueprint
    const inventoryDigest = CapsuleBranchResourceInventoryDigestSchema.parse(branch.resourceInventoryDigest)
    if (branch.blueprintName !== provenance.blueprint.name || branch.blueprintDigest !== provenance.blueprint.digest) {
      conflict(operationId, 'Source branch Blueprint identity disagrees with its reconstruction provenance.')
    }
    assertCapsuleBranchResourceInventoryMatches(
      inventoryDigest,
      resources.map(resource => ({
        provider: resource.provider,
        resourceType: resource.resourceType,
        resourceKey: resource.resourceKey,
        blueprintVolumeName: resource.blueprintVolumeName,
        cleanupPolicy: resource.cleanupPolicy,
        metadata: resource.metadata,
      })),
    )
    for (const resource of resources) {
      if (
        resource.ownerId !== branch.ownerId ||
        resource.branchId !== branch.id ||
        resource.branchName !== branch.name ||
        resource.createdByOperationId !== provenance.operationId ||
        resource.provider !== 'incus'
      ) {
        conflict(operationId, 'Source inventory contains foreign or unproven resources.')
      }
      const adopted = resource.resourceType === 'incus_project' || resource.resourceType === 'bind_mount'
      if (
        resource.status !== (adopted ? 'adopted' : 'created') ||
        resource.failureCode !== null ||
        resource.failureMessage !== null ||
        resource.failureDetails !== null
      ) {
        conflict(operationId, 'Source inventory contains unconfirmed outcomes or contradictory failure evidence.')
      }
    }
    const project = `user-${branch.ownerId}`
    const instanceName = branchInstanceName(branch.id)
    const projects = resources.filter(resource => resource.resourceType === 'incus_project')
    const instances = resources.filter(resource => resource.resourceType === 'incus_instance')
    if (projects.length !== 1 || instances.length !== 1) {
      conflict(operationId, 'Source inventory must identify exactly one project and branch instance.')
    }
    const projectResource = projects[0]!
    const instanceResource = instances[0]!
    const projectMetadata = parseProjectResourceMetadata(projectResource.metadata)
    const instanceMetadata = parseInstanceResourceMetadata(instanceResource.metadata)
    if (
      projectMetadata.namespace !== project ||
      projectResource.resourceKey !== projectResourceKey(project) ||
      projectResource.cleanupPolicy !== 'retain' ||
      instanceMetadata.namespace !== project ||
      instanceMetadata.instanceName !== instanceName ||
      instanceResource.resourceKey !== instanceResourceKey(project, instanceName) ||
      instanceResource.cleanupPolicy !== 'delete_with_branch' ||
      !sameRootfs(instanceMetadata.rootfsImagePin, provenance.rootfsImagePin)
    ) {
      conflict(operationId, 'Source runtime inventory disagrees with its pinned reconstruction identity.')
    }
    const volumeResources = resources.filter(
      resource => resource.resourceType === 'zfs_volume' || resource.resourceType === 'bind_mount',
    )
    if (volumeResources.length !== blueprint.provisioning.volumes.length) {
      conflict(operationId, 'Source volume inventory does not exactly cover the historical Blueprint.')
    }
    const volumes: SnapshotVolume[] = []
    for (const volume of blueprint.provisioning.volumes) {
      const matches = volumeResources.filter(resource => resource.blueprintVolumeName === volume.name)
      if (matches.length !== 1) {
        conflict(operationId, 'A Blueprint volume does not resolve exactly one source resource.')
      }
      const resource = matches[0]!
      if (volume.type === 'bind') {
        const metadata = parseBindMountResourceMetadata(resource.metadata)
        if (
          resource.resourceType !== 'bind_mount' ||
          resource.cleanupPolicy !== 'external' ||
          metadata.namespace !== project ||
          metadata.hostPath !== volume.host_path ||
          metadata.mountPath !== volume.mount_path ||
          metadata.readonly !== volume.readonly ||
          metadata.shifted !== volume.shifted ||
          resource.resourceKey !== bindMountResourceKey(project, volume.host_path, volume.mount_path)
        ) {
          conflict(operationId, 'Source bind configuration disagrees with the historical Blueprint.')
        }
        continue
      }
      const metadata = parseVolumeResourceMetadata(resource.metadata)
      if (
        resource.resourceType !== 'zfs_volume' ||
        resource.cleanupPolicy !== 'delete_with_branch' ||
        metadata.namespace !== project ||
        metadata.pool !== volume.pool ||
        metadata.mountPath !== volume.mount_path ||
        resource.resourceKey !== volumeResourceKey(project, metadata.pool, metadata.volumeName)
      ) {
        conflict(operationId, 'Source managed-volume identity disagrees with the historical Blueprint.')
      }
      volumes.push({
        blueprintVolumeName: volume.name,
        sourceBranchResourceId: resource.id,
        provider: 'incus',
        kind: 'custom_volume_snapshot',
        project,
        pool: metadata.pool,
        sourceVolume: metadata.volumeName,
        snapshotName: `qiln-${operationId}-${volume.name}`,
      })
    }
    volumes.sort((left, right) =>
      left.blueprintVolumeName < right.blueprintVolumeName
        ? -1
        : left.blueprintVolumeName > right.blueprintVolumeName
          ? 1
          : 0,
    )
    return {
      project,
      instanceName,
      inventoryDigest,
      volumes,
    }
  }

  /**
   * Compares accepted accounting identities without interpreting progress as
   * committed restoration authority.
   */
  public assertResources(operationId: string, plan: SnapshotPlan, resources: readonly SnapshotResource[]): void {
    if (resources.length !== plan.volumes.length) {
      conflict(operationId, 'Snapshot accounting does not cover every accepted managed volume.')
    }
    const seen = new Set<string>()
    for (const resource of resources) {
      const volume = plan.volumes.find(candidate => candidate.blueprintVolumeName === resource.blueprintVolumeName)
      if (
        !volume ||
        seen.has(resource.blueprintVolumeName) ||
        resource.operationId !== operationId ||
        resource.sourceBranchResourceId !== volume.sourceBranchResourceId ||
        resource.provider !== volume.provider ||
        resource.kind !== volume.kind ||
        resource.project !== volume.project ||
        resource.pool !== volume.pool ||
        resource.sourceVolume !== volume.sourceVolume ||
        resource.snapshotName !== volume.snapshotName
      ) {
        conflict(operationId, 'Snapshot accounting contains contradictory provider identities.')
      }
      seen.add(resource.blueprintVolumeName)
    }
  }
}
