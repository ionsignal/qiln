import type { CapsuleArchiveReceipt, CapsuleLifecycleState, CapsuleOperationRequestHash } from '@qiln/core/server'
import type { CapsuleOperationTransitionOutput } from '../../shared'

export interface SubmitArchiveCapsuleInput {
  ownerId: string
  capsuleId: string
  idempotencyKey: string
}

export interface AcceptArchiveCapsuleOperationInput extends SubmitArchiveCapsuleInput {
  requestHash: CapsuleOperationRequestHash
}

export interface ArchiveCapsuleExecutionInput {
  operationId: string
  ownerId: string
  capsuleId: string
}

export interface ArchiveCapsuleAcceptanceResult {
  newlyAccepted: boolean
  receipt: CapsuleArchiveReceipt
  operation: CapsuleOperationTransitionOutput
  capsule: CapsuleLifecycleState
}

export interface ArchiveCapsuleTerminalResult {
  operation: CapsuleOperationTransitionOutput
  capsule: CapsuleLifecycleState
}

export type ArchiveCapsuleAbandonedClassificationResult = ArchiveCapsuleTerminalResult | null
