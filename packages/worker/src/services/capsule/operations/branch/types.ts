import type {
  CapsuleActorReference,
  CapsuleBranchStartReceipt,
  CapsuleBranchStatus,
  CapsuleBranchStopReceipt,
  CapsuleOperationRequestHash,
  CapsuleTables,
} from '@qiln/core/server'
import type { CapsuleOperationTransitionOutput } from '../shared'

export type BranchOperationType = 'branch_start' | 'branch_stop'

export interface BranchReceipts {
  branch_start: CapsuleBranchStartReceipt
  branch_stop: CapsuleBranchStopReceipt
}

export type BranchReceipt<TOperation extends BranchOperationType> = BranchReceipts[TOperation]

export interface SubmitBranchInput {
  ownerId: string
  actor: CapsuleActorReference
  capsuleId: string
  branchId: string
  idempotencyKey: string
}

export interface AcceptBranchInput extends SubmitBranchInput {
  requestHash: CapsuleOperationRequestHash
}

export interface BranchState {
  id: string
  capsuleId: string
  name: string
  status: CapsuleBranchStatus
}

export interface BranchAcceptance<TOperation extends BranchOperationType> {
  newlyAccepted: boolean
  receipt: BranchReceipt<TOperation>
  operation: CapsuleOperationTransitionOutput
  branch: BranchState
}

export interface BranchExecutionInput {
  operationId: string
  ownerId: string
  capsuleId: string
  branchId: string
  branchName: string
}

/**
 * The shared submission boundary schedules an explicit operation executor. It
 * does not select, configure, or interpret that executor's workflow.
 */
export interface BranchExecutor {
  execute(operationId: string): Promise<void>
}

export type BranchFailureDisposition = 'pre_provider' | 'previous_confirmed' | 'cleanup_required'

export interface BranchFailureInput {
  operationId: string
  error: unknown
  phase: string
  disposition: BranchFailureDisposition

  /**
   * Stop may positively observe an online runtime without an address. Null is
   * that explicit observation; undefined means no replacement was observed.
   */
  runtimeIp?: string | null
}

export interface BranchTerminalResult {
  operation: CapsuleOperationTransitionOutput
  branch: BranchState | null
  branchChanged: boolean
}

export type BranchOperationRow = CapsuleTables['capsuleOperations']['$inferSelect']
export type BranchExtensionRow = CapsuleTables['capsuleBranchRuntimeOperations']['$inferSelect']
export type BranchCapsuleRow = CapsuleTables['capsules']['$inferSelect']
export type BranchRow = CapsuleTables['capsuleBranches']['$inferSelect']

/**
 * Incomplete or contradictory target relationships remain representable so
 * classification can fence the operation without mutating an unrelated branch.
 */
export interface LockedBranchOperation {
  capsule: BranchCapsuleRow
  operation: BranchOperationRow
  extension: BranchExtensionRow | null
  branch: BranchRow | null
}

export interface ValidatedBranchOperation extends LockedBranchOperation {
  extension: BranchExtensionRow
  branch: BranchRow
}

export interface BranchFailureDecision {
  cleanupRequired: boolean
  identityValid: boolean
  branchStatus: 'online' | 'offline' | 'cleanup_required' | null
  reasons: string[]
}
