import { CapsuleCreateReceiptSchema, CapsuleOperationType, type CapsuleTables } from '@qiln/core/server'
import { toCapsuleLifecycleState, toCapsuleOperationTransition } from '../../shared'
import type { CapsuleOperationTransitionOutput } from '../../shared'
import type { CreateCapsuleCommittedBranch, CreateCapsuleRepositoryResult, CreateCapsuleTerminalResult } from '../types'

type OperationResultRow = Pick<
  CapsuleTables['capsuleOperations']['$inferSelect'],
  'id' | 'ownerId' | 'capsuleId' | 'status'
>

type CapsuleResultRow = Pick<
  CapsuleTables['capsules']['$inferSelect'],
  'id' | 'lifecycleStatus' | 'archivedAt' | 'destroyedAt'
>

type BranchResultRow = Pick<CapsuleTables['capsuleBranches']['$inferSelect'], 'id' | 'capsuleId' | 'name' | 'status'>

/**
 * Maps already-validated durable create rows without deciding eligibility,
 * opening transactions, or reconstructing state from executor assumptions.
 */
export function toCreateOperationTransition(operation: OperationResultRow): CapsuleOperationTransitionOutput {
  return toCapsuleOperationTransition({
    ownerId: operation.ownerId,
    operationId: operation.id,
    capsuleId: operation.capsuleId,
    operationType: CapsuleOperationType.CREATE,
    operationStatus: operation.status,
  })
}

export function toCreateBranchResult(branch: BranchResultRow): CreateCapsuleCommittedBranch {
  return {
    id: branch.id,
    capsuleId: branch.capsuleId,
    name: branch.name,
    status: branch.status,
  }
}

export function toCreateTerminalResult(
  operation: OperationResultRow,
  capsule: CapsuleResultRow,
  branch: BranchResultRow | null,
): CreateCapsuleTerminalResult {
  return {
    operation: toCreateOperationTransition(operation),
    capsule: toCapsuleLifecycleState({
      capsuleId: capsule.id,
      lifecycleStatus: capsule.lifecycleStatus,
      archivedAt: capsule.archivedAt,
      destroyedAt: capsule.destroyedAt,
    }),
    branch: branch === null ? null : toCreateBranchResult(branch),
  }
}

export function toCreateRepositoryResult(
  operation: OperationResultRow,
  capsule: CapsuleResultRow,
  branch: BranchResultRow,
  options: {
    newlyAccepted: boolean
    replayed: boolean
  },
): CreateCapsuleRepositoryResult {
  return {
    ...toCreateTerminalResult(operation, capsule, branch),
    branch: toCreateBranchResult(branch),
    newlyAccepted: options.newlyAccepted,
    receipt: CapsuleCreateReceiptSchema.parse({
      operationId: operation.id,
      operationType: CapsuleOperationType.CREATE,
      operationStatus: operation.status,
      capsuleId: operation.capsuleId,
      rootBranchId: branch.id,
      rootBranchName: branch.name,
      replayed: options.replayed,
    }),
  }
}
