import { verifyCapsuleBlueprintPin, type CapsuleTables } from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import type { DestroyBranch, DestroyBranchProof, DestroyOperation } from '../types'

type Create = CapsuleTables['capsuleCreateOperations']['$inferSelect']
type Fork = CapsuleTables['capsuleForkOperations']['$inferSelect']

/**
 * Deletion needs immutable footprint attribution, not pristine creation
 * accounting. Mutable branch names, sizing, statuses, and old diagnostics do
 * not change UUID-derived provider identities.
 */
export function proveBranch(
  branch: DestroyBranch,
  operations: ReadonlyMap<string, DestroyOperation>,
  creates: readonly Create[],
  forks: readonly Fork[],
): DestroyBranchProof {
  const create = creates.filter(candidate => candidate.rootBranchId === branch.id)
  const fork = forks.filter(candidate => candidate.targetBranchId === branch.id)
  if (
    (branch.isRootBranch && (create.length !== 1 || fork.length !== 0)) ||
    (!branch.isRootBranch && (fork.length !== 1 || create.length !== 0))
  ) {
    throw new IncusError('Branch deletion requires one unambiguous create or fork provenance record.', 'CONFLICT', {
      branchId: branch.id,
    })
  }
  const extension = branch.isRootBranch ? create[0]! : fork[0]!
  const origin = operations.get(extension.operationId)
  const expectedType = branch.isRootBranch ? 'create' : 'fork'
  if (
    !origin ||
    origin.type !== expectedType ||
    origin.ownerId !== branch.ownerId ||
    origin.capsuleId !== branch.capsuleId ||
    origin.status === 'accepted' ||
    origin.status === 'running'
  ) {
    throw new IncusError('Branch deletion provenance does not resolve an owned terminal origin operation.', 'CONFLICT', {
      branchId: branch.id,
      operationId: extension.operationId,
    })
  }
  const blueprint = branch.isRootBranch
    ? verifyCapsuleBlueprintPin({
        name: create[0]!.blueprintName,
        digest: create[0]!.blueprintDigest,
        blueprint: create[0]!.blueprintSnapshot,
      })
    : verifyCapsuleBlueprintPin(fork[0]!.blueprintPin)
  if (
    blueprint.name !== extension.blueprintName ||
    blueprint.digest !== extension.blueprintDigest ||
    branch.blueprintName !== blueprint.name ||
    branch.blueprintDigest !== blueprint.digest ||
    (!branch.isRootBranch && fork[0]!.blueprintSchemaVersion !== blueprint.blueprint.schema_version)
  ) {
    throw new IncusError('Branch deletion footprint disagrees with its immutable Blueprint identity.', 'CONFLICT', {
      branchId: branch.id,
      operationId: origin.id,
    })
  }
  return {
    branch,
    origin,
    blueprint,
    sourceSnapshotId: branch.isRootBranch ? null : fork[0]!.sourceSnapshotId,
  }
}
