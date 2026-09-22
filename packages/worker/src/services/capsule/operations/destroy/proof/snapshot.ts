import { verifyCapsuleBlueprintPin, type CapsuleDestroyResourcePlan } from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import { branchVolumeName } from '../../../resource/identity'
import type {
  DestroyBranchProof,
  DestroyOperation,
  DestroyResource,
  DestroySnapshot,
  DestroySnapshotOperation,
  DestroySnapshotReference,
  DestroySnapshotResource,
} from '../types'

export interface SnapshotProofInput {
  branches: ReadonlyMap<string, DestroyBranchProof>
  operations: ReadonlyMap<string, DestroyOperation>
  snapshots: readonly DestroySnapshot[]
  extensions: readonly DestroySnapshotOperation[]
  resources: readonly DestroySnapshotResource[]
  references: readonly DestroySnapshotReference[]
  branchResources: readonly DestroyResource[]
}

/**
 * Every target must have an accepted resource identity or a committed
 * reference. Missing both is ambiguous; the current planner must not invent a
 * historical snapshot name.
 */
export function snapshotTargets(input: SnapshotProofInput): CapsuleDestroyResourcePlan[] {
  const result: CapsuleDestroyResourcePlan[] = []
  const visitedSnapshots = new Set<string>()
  const visitedResources = new Set<string>()
  const visitedReferences = new Set<string>()
  for (const extension of input.extensions) {
    const operation = input.operations.get(extension.operationId)
    const branch = input.branches.get(extension.sourceBranchId)
    if (
      !operation ||
      operation.type !== 'snapshot_create' ||
      !branch ||
      operation.ownerId !== branch.branch.ownerId ||
      operation.capsuleId !== branch.branch.capsuleId ||
      operation.status === 'accepted' ||
      operation.status === 'running'
    ) {
      throw new IncusError('Snapshot deletion provenance does not resolve an owned terminal capture.', 'CONFLICT', {
        operationId: extension.operationId,
      })
    }
    const blueprint = verifyCapsuleBlueprintPin(extension.blueprintPin)
    if (
      blueprint.name !== extension.blueprintName ||
      blueprint.digest !== extension.blueprintDigest ||
      blueprint.blueprint.schema_version !== extension.blueprintSchemaVersion ||
      blueprint.name !== branch.blueprint.name ||
      blueprint.digest !== branch.blueprint.digest
    ) {
      throw new IncusError('Snapshot deletion Blueprint evidence is contradictory.', 'CONFLICT', {
        operationId: operation.id,
      })
    }
    const snapshot =
      extension.snapshotId === null
        ? undefined
        : input.snapshots.find(candidate => candidate.id === extension.snapshotId)
    if (extension.snapshotId !== null) {
      if (
        !snapshot ||
        snapshot.capsuleId !== operation.capsuleId ||
        snapshot.sourceBranchId !== branch.branch.id ||
        snapshot.blueprintName !== blueprint.name ||
        snapshot.blueprintDigest !== blueprint.digest ||
        verifyCapsuleBlueprintPin(snapshot.blueprintPin).digest !== blueprint.digest
      ) {
        throw new IncusError('Committed snapshot deletion evidence disagrees with its capture.', 'CONFLICT', {
          operationId: operation.id,
          snapshotId: extension.snapshotId,
        })
      }
      visitedSnapshots.add(snapshot.id)
    }
    const resources = input.resources.filter(resource => resource.operationId === operation.id)
    const references =
      snapshot === undefined ? [] : input.references.filter(reference => reference.snapshotId === snapshot.id)
    const versioned = blueprint.blueprint.provisioning.volumes.filter(
      volume => volume.type !== 'bind' && volume.versioned,
    )
    for (const volume of versioned) {
      if (volume.type === 'bind') {
        continue
      }
      const accepted = resources.filter(resource => resource.blueprintVolumeName === volume.name)
      const committed = references.filter(reference => reference.blueprintVolumeName === volume.name)
      if (accepted.length > 1 || committed.length > 1) {
        throw new IncusError('Snapshot deletion has duplicate volume identities.', 'CONFLICT', {
          operationId: operation.id,
          blueprintVolumeName: volume.name,
        })
      }
      const resource = accepted[0]
      const reference = committed[0]
      if (!resource && !reference) {
        if (operation.providerMutationStartedAt !== null || snapshot !== undefined) {
          throw new IncusError('Snapshot provider intent lacks an exact accepted deletion identity.', 'CONFLICT', {
            operationId: operation.id,
            blueprintVolumeName: volume.name,
          })
        }
        continue
      }
      const identity = resource ?? reference!
      const project = `user-${operation.ownerId}`
      if (
        identity.provider !== 'incus' ||
        identity.kind !== 'custom_volume_snapshot' ||
        identity.project !== project ||
        identity.pool !== volume.pool ||
        identity.sourceVolume !== branchVolumeName(branch.branch.id, volume.name) ||
        (resource &&
          reference &&
          (reference.createResourceId !== resource.id ||
            reference.sourceBranchResourceId !== resource.sourceBranchResourceId ||
            reference.snapshotName !== resource.snapshotName ||
            reference.project !== resource.project ||
            reference.pool !== resource.pool ||
            reference.sourceVolume !== resource.sourceVolume))
      ) {
        throw new IncusError('Snapshot deletion identity is outside its proven managed volume.', 'CONFLICT', {
          operationId: operation.id,
          blueprintVolumeName: volume.name,
        })
      }
      const source = input.branchResources.find(candidate => candidate.id === identity.sourceBranchResourceId)
      if (
        source &&
        (source.ownerId !== operation.ownerId ||
          source.branchId !== branch.branch.id ||
          source.blueprintVolumeName !== volume.name ||
          source.resourceType !== 'zfs_volume')
      ) {
        throw new IncusError('Snapshot deletion references contradictory source resource accounting.', 'CONFLICT', {
          operationId: operation.id,
          resourceId: source.id,
        })
      }
      if (resource) {
        visitedResources.add(resource.id)
      }
      if (reference) {
        visitedReferences.add(reference.id)
      }
      result.push({
        target: {
          kind: 'snapshot',
          provider: 'incus',
          project,
          pool: identity.pool,
          volumeName: identity.sourceVolume,
          snapshotName: identity.snapshotName,
        },
        proof: {
          source: 'snapshot',
          branchId: branch.branch.id,
          operationId: operation.id,
          createResourceId: resource?.id ?? reference!.createResourceId,
          snapshotId: snapshot?.id ?? null,
          blueprintVolumeName: volume.name,
        },
      })
    }
  }
  if (
    input.snapshots.some(snapshot => !visitedSnapshots.has(snapshot.id)) ||
    input.resources.some(resource => !visitedResources.has(resource.id)) ||
    input.references.some(reference => !visitedReferences.has(reference.id)) ||
    [...input.operations.values()].some(
      operation =>
        operation.type === 'snapshot_create' &&
        operation.providerMutationStartedAt !== null &&
        !input.extensions.some(extension => extension.operationId === operation.id),
    )
  ) {
    throw new IncusError('Snapshot deletion cannot prove complete capture and restoration coverage.', 'CONFLICT')
  }
  return result
}
