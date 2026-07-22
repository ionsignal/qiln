import { IncusError } from '../../../../../errors'
import type { DestroyCapsuleAcceptedBranch } from '../types'

export type DestroyCapsuleLineageRequiredStatus = 'offline' | 'destroying'

export interface DestroyCapsuleBranchLineageDescription {
  branchId: string
  capsuleId: string
  ownerId: string
  branchName: string
  status: DestroyCapsuleAcceptedBranch['status']
  isRootBranch: boolean
}

export interface DestroyCapsuleBranchLineageInspection {
  valid: boolean
  branchCount: number
  rootBranchCount: number
  requiredStatus: DestroyCapsuleLineageRequiredStatus
  branches: DestroyCapsuleBranchLineageDescription[]
}

/**
 * Produces mechanical evidence about the branch lineage required by a destroy
 * operation.
 *
 * This helper does not decide whether invalid evidence should reject
 * acceptance, fail an operation, or require cleanup. That policy remains with
 * the caller's destroy-specific transaction.
 */
export function inspectDestroyCapsuleBranchLineage(
  ownerId: string,
  capsuleId: string,
  branches: readonly DestroyCapsuleAcceptedBranch[],
  requiredStatus: DestroyCapsuleLineageRequiredStatus,
): DestroyCapsuleBranchLineageInspection {
  const rootBranchCount = branches.filter(branch => branch.isRootBranch).length
  const valid =
    branches.length > 0 &&
    rootBranchCount === 1 &&
    branches.every(
      branch => branch.ownerId === ownerId && branch.capsuleId === capsuleId && branch.status === requiredStatus,
    )
  return {
    valid,
    branchCount: branches.length,
    rootBranchCount,
    requiredStatus,
    branches: branches.map(branch => ({
      branchId: branch.id,
      capsuleId: branch.capsuleId,
      ownerId: branch.ownerId,
      branchName: branch.name,
      status: branch.status,
      isRootBranch: branch.isRootBranch,
    })),
  }
}

/**
 * Rejects destroy acceptance unless the complete capsule branch lineage is
 * offline, owner-consistent, capsule-consistent, non-empty, and contains
 * exactly one root branch.
 */
export function assertOfflineDestroyCapsuleBranchLineage(
  ownerId: string,
  capsuleId: string,
  branches: readonly DestroyCapsuleAcceptedBranch[],
): void {
  const inspection = inspectDestroyCapsuleBranchLineage(ownerId, capsuleId, branches, 'offline')
  if (inspection.valid) {
    return
  }
  throw new IncusError('Capsule destroy requires exactly one root branch and every branch offline.', 'CONFLICT', {
    ownerId,
    capsuleId,
    branchCount: inspection.branchCount,
    rootBranchCount: inspection.rootBranchCount,
    branches: inspection.branches,
  })
}

/**
 * Rejects destroy execution, planning, or completion unless the complete
 * capsule branch lineage remains inside the durable destroy mutation fence.
 */
export function assertDestroyingCapsuleBranchLineage(
  ownerId: string,
  capsuleId: string,
  branches: readonly DestroyCapsuleAcceptedBranch[],
): void {
  const inspection = inspectDestroyCapsuleBranchLineage(ownerId, capsuleId, branches, 'destroying')
  if (inspection.valid) {
    return
  }
  throw new IncusError('Capsule destroy requires every durable branch to remain in its destroy fence.', 'CONFLICT', {
    ownerId,
    capsuleId,
    branchCount: inspection.branchCount,
    rootBranchCount: inspection.rootBranchCount,
    branches: inspection.branches,
  })
}
