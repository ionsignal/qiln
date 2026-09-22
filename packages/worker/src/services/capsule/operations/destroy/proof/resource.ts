import type { CapsuleDestroyResourcePlan } from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import {
  bindMountResourceKey,
  branchInstanceName,
  branchVolumeName,
  instanceResourceKey,
  projectResourceKey,
  volumeResourceKey,
} from '../../../resource/identity'
import {
  parseBindMountResourceMetadata,
  parseInstanceResourceMetadata,
  parseProjectResourceMetadata,
  parseProvisioningFileResourceMetadata,
  parseVolumeResourceMetadata,
} from '../../../resource/metadata'
import type { DestroyBranchProof, DestroyResource } from '../types'

/**
 * These UUID-based identities are the existing supported provider naming
 * contract. Recorded identities must agree; drift never selects a replacement
 * resource for deletion.
 */
export function branchTargets(proof: DestroyBranchProof): CapsuleDestroyResourcePlan[] {
  const { branch, origin, blueprint } = proof
  const project = `user-${branch.ownerId}`
  const base = {
    source: 'branch' as const,
    branchId: branch.id,
    originOperationId: origin.id,
    originType: branch.isRootBranch ? ('create' as const) : ('fork' as const),
    blueprintDigest: blueprint.digest,
    inventoryDigest: branch.resourceInventoryDigest,
  }
  return [
    {
      target: {
        kind: 'instance',
        provider: 'incus',
        project,
        instanceName: branchInstanceName(branch.id),
      },
      proof: {
        ...base,
        blueprintVolumeName: null,
      },
    },
    ...blueprint.blueprint.provisioning.volumes.flatMap<CapsuleDestroyResourcePlan>(volume =>
      volume.type === 'bind'
        ? []
        : [
            {
              target: {
                kind: 'volume',
                provider: 'incus',
                project,
                pool: volume.pool,
                volumeName: branchVolumeName(branch.id, volume.name),
              },
              proof: {
                ...base,
                blueprintVolumeName: volume.name,
              },
            },
          ],
    ),
  ]
}

/**
 * Missing accounting can be reconstructed from immutable branch provenance.
 * Contradictory recorded provider identities cannot be ignored.
 *
 * No old status, last-operation reference, or failure field is rewritten.
 * Provisioning files and binds have no independent deletion obligation.
 */
export function verifyResources(proof: DestroyBranchProof, resources: readonly DestroyResource[]): void {
  const { branch, origin, blueprint } = proof
  const namespace = `user-${branch.ownerId}`
  const instanceName = branchInstanceName(branch.id)
  for (const resource of resources) {
    if (
      resource.ownerId !== branch.ownerId ||
      (resource.branchId !== null && resource.branchId !== branch.id) ||
      (resource.createdByOperationId !== null && resource.createdByOperationId !== origin.id) ||
      resource.provider !== 'incus'
    ) {
      throw new IncusError('Recorded resource attribution contradicts branch deletion provenance.', 'CONFLICT', {
        branchId: branch.id,
        resourceId: resource.id,
      })
    }
    let valid = false
    switch (resource.resourceType) {
      case 'incus_project': {
        const metadata = parseProjectResourceMetadata(resource.metadata)
        valid =
          metadata.namespace === namespace &&
          resource.resourceKey === projectResourceKey(namespace) &&
          resource.cleanupPolicy === 'retain'
        break
      }
      case 'incus_instance': {
        const metadata = parseInstanceResourceMetadata(resource.metadata)
        valid =
          metadata.namespace === namespace &&
          metadata.instanceName === instanceName &&
          resource.resourceKey === instanceResourceKey(namespace, instanceName) &&
          resource.cleanupPolicy === 'delete_with_branch'
        break
      }
      case 'zfs_volume': {
        const volume = blueprint.blueprint.provisioning.volumes.find(
          candidate => candidate.name === resource.blueprintVolumeName,
        )
        const metadata = parseVolumeResourceMetadata(resource.metadata)
        valid =
          volume !== undefined &&
          volume.type !== 'bind' &&
          metadata.namespace === namespace &&
          metadata.pool === volume.pool &&
          metadata.volumeName === branchVolumeName(branch.id, volume.name) &&
          resource.resourceKey === volumeResourceKey(namespace, metadata.pool, metadata.volumeName) &&
          resource.cleanupPolicy === 'delete_with_branch'
        break
      }
      case 'bind_mount': {
        const volume = blueprint.blueprint.provisioning.volumes.find(
          candidate => candidate.name === resource.blueprintVolumeName,
        )
        const metadata = parseBindMountResourceMetadata(resource.metadata)
        valid =
          volume?.type === 'bind' &&
          metadata.namespace === namespace &&
          metadata.hostPath === volume.host_path &&
          metadata.mountPath === volume.mount_path &&
          resource.resourceKey === bindMountResourceKey(namespace, volume.host_path, volume.mount_path) &&
          resource.cleanupPolicy === 'external'
        break
      }
      case 'provisioning_file': {
        const metadata = parseProvisioningFileResourceMetadata(resource.metadata)
        valid =
          metadata.namespace === namespace &&
          metadata.instanceName === instanceName &&
          resource.cleanupPolicy === 'delete_with_branch' &&
          (metadata.target === 'instance' ||
            blueprint.blueprint.provisioning.volumes.some(
              volume =>
                volume.type !== 'bind' &&
                volume.pool === metadata.pool &&
                branchVolumeName(branch.id, volume.name) === metadata.volumeName,
            ))
        break
      }
    }
    if (!valid) {
      throw new IncusError('Recorded resource identity is outside the proven branch deletion footprint.', 'CONFLICT', {
        branchId: branch.id,
        resourceId: resource.id,
        resourceType: resource.resourceType,
      })
    }
  }
}
