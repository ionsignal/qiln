import { CapsuleCreateReceiptSchema, CapsuleOperationType, type CapsuleTables } from '@qiln/core/server'
import { toCapsuleLifecycleState, toCapsuleOperationTransition } from '../../shared'
import type { CapsuleOperationTransitionOutput } from '../../shared'
import type { CapsuleCreateBranchState, CapsuleCreateAcceptanceResult, CapsuleCreateTerminalResult } from '../types'

type OperationResultRow<TTables extends CapsuleTables> = Pick<
  TTables['capsuleOperations']['$inferSelect'],
  'id' | 'ownerId' | 'capsuleId' | 'status'
>

type CapsuleResultRow<TTables extends CapsuleTables> = Pick<
  TTables['capsules']['$inferSelect'],
  'id' | 'lifecycleStatus' | 'archivedAt' | 'destroyedAt'
>

type BranchResultRow<TTables extends CapsuleTables> = Pick<
  TTables['capsuleBranches']['$inferSelect'],
  'id' | 'capsuleId' | 'name' | 'status'
>

/**
 * Maps already-validated durable create rows without deciding eligibility,
 * opening transactions, or reconstructing state from executor assumptions.
 */
export function toCreateOperationTransition<TTables extends CapsuleTables>(
  operation: OperationResultRow<TTables>,
): CapsuleOperationTransitionOutput {
  return toCapsuleOperationTransition({
    ownerId: operation.ownerId,
    operationId: operation.id,
    capsuleId: operation.capsuleId,
    operationType: CapsuleOperationType.CREATE,
    operationStatus: operation.status,
  })
}

export function toCreateBranchResult<TTables extends CapsuleTables>(
  branch: BranchResultRow<TTables>,
): CapsuleCreateBranchState {
  return {
    id: branch.id,
    capsuleId: branch.capsuleId,
    name: branch.name,
    status: branch.status,
  }
}

export function toCreateTerminalResult<TTables extends CapsuleTables>(
  operation: OperationResultRow<TTables>,
  capsule: CapsuleResultRow<TTables>,
  branch: BranchResultRow<TTables> | null,
): CapsuleCreateTerminalResult {
  return {
    operation: toCreateOperationTransition<TTables>(operation),
    capsule: toCapsuleLifecycleState({
      capsuleId: capsule.id,
      lifecycleStatus: capsule.lifecycleStatus,
      archivedAt: capsule.archivedAt,
      destroyedAt: capsule.destroyedAt,
    }),
    branch: branch === null ? null : toCreateBranchResult<TTables>(branch),
  }
}

export function toCreateRepositoryResult<TTables extends CapsuleTables>(
  operation: OperationResultRow<TTables>,
  capsule: CapsuleResultRow<TTables>,
  branch: BranchResultRow<TTables>,
  options: {
    newlyAccepted: boolean
    replayed: boolean
  },
): CapsuleCreateAcceptanceResult {
  return {
    ...toCreateTerminalResult<TTables>(operation, capsule, branch),
    branch: toCreateBranchResult<TTables>(branch),
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
