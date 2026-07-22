import type {
  CapsuleActorReference,
  CapsuleArchiveReceipt,
  CapsuleLifecycleState,
  CapsuleOperationRequestHash,
} from '@qiln/core/server'
import type { CapsuleOperationTransitionOutput } from '../../shared'
import type { ProviderFreeArchivalTerminalResult } from '../shared/execution'

export interface SubmitArchiveCapsuleInput {
  ownerId: string
  actor: CapsuleActorReference
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

export interface ArchiveCapsuleTerminalResult extends ProviderFreeArchivalTerminalResult {
  operation: CapsuleOperationTransitionOutput
  capsule: CapsuleLifecycleState
}

export type ArchiveCapsuleAbandonedClassificationResult = ArchiveCapsuleTerminalResult | null
