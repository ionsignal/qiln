import type { CapsuleLifecycleState, CapsuleOperationRequestHash, CapsuleUnarchiveReceipt } from '@qiln/core/server'
import type { CapsuleOperationTransitionOutput } from '../../shared'
import type { ProviderFreeArchivalTerminalResult } from '../shared/execution'

export interface SubmitUnarchiveCapsuleInput {
  ownerId: string
  capsuleId: string
  idempotencyKey: string
}

export interface AcceptUnarchiveCapsuleOperationInput extends SubmitUnarchiveCapsuleInput {
  requestHash: CapsuleOperationRequestHash
}

export interface UnarchiveCapsuleExecutionInput {
  operationId: string
  ownerId: string
  capsuleId: string
}

export interface UnarchiveCapsuleAcceptanceResult {
  newlyAccepted: boolean
  receipt: CapsuleUnarchiveReceipt
  operation: CapsuleOperationTransitionOutput
  capsule: CapsuleLifecycleState
}

export interface UnarchiveCapsuleTerminalResult extends ProviderFreeArchivalTerminalResult {
  operation: CapsuleOperationTransitionOutput
  capsule: CapsuleLifecycleState
}

export type UnarchiveCapsuleAbandonedClassificationResult = UnarchiveCapsuleTerminalResult | null
