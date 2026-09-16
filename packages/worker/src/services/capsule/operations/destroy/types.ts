import type {
  CapsuleActorReference,
  CapsuleBlueprintPin,
  CapsuleDestroyOptions,
  CapsuleDestroyOptionsInput,
  CapsuleDestroyPlan,
  CapsuleDestroyReceipt,
  CapsuleDestroyResourcePlan,
  CapsuleLifecycleState,
  CapsuleOperationRequestHash,
  CapsuleTables,
} from '@qiln/core/server'
import type { CapsuleOperationTransitionOutput } from '../shared'

export type DestroyOperation = CapsuleTables['capsuleOperations']['$inferSelect']
export type DestroyCapsule = CapsuleTables['capsules']['$inferSelect']
export type DestroyBranch = CapsuleTables['capsuleBranches']['$inferSelect']
export type DestroyResource = CapsuleTables['capsuleBranchResources']['$inferSelect']
export type DestroyTarget = CapsuleTables['capsuleDestroyResources']['$inferSelect']
export type DestroySnapshot = CapsuleTables['capsuleSnapshots']['$inferSelect']
export type DestroySnapshotOperation = CapsuleTables['capsuleSnapshotCreateOperations']['$inferSelect']
export type DestroySnapshotResource = CapsuleTables['capsuleSnapshotCreateResources']['$inferSelect']
export type DestroySnapshotReference = CapsuleTables['capsuleSnapshotResourceReferences']['$inferSelect']
export type DestroyAlias = CapsuleTables['capsuleRouteAliases']['$inferSelect']
export type DestroyRevision = CapsuleTables['capsuleRouteRevisions']['$inferSelect']
export type DestroyRouteOperation = CapsuleTables['capsuleRouteOperations']['$inferSelect']
export type DestroyRouteProvider = CapsuleTables['capsuleRouteProviderApplications']['$inferSelect']
export type DestroyPreview = CapsuleTables['capsuleBranchPreviews']['$inferSelect']

interface DestroyIdentity {
  ownerId: string
  actor: CapsuleActorReference
  capsuleId: string
  idempotencyKey: string
}

export type SubmitDestroyCapsuleInput = DestroyIdentity & CapsuleDestroyOptionsInput

export type AcceptDestroyCapsuleOperationInput = DestroyIdentity &
  CapsuleDestroyOptions & {
    requestHash: CapsuleOperationRequestHash
  }

export interface DestroyCapsuleCommittedBranch {
  id: string
  capsuleId: string
  name: string
  status: DestroyBranch['status']
}

export interface DestroyCapsuleTerminalResult {
  operation: CapsuleOperationTransitionOutput
  capsule: CapsuleLifecycleState
  branches: DestroyCapsuleCommittedBranch[]
}

export interface DestroyCapsuleRepositoryResult extends DestroyCapsuleTerminalResult {
  newlyAccepted: boolean
  receipt: CapsuleDestroyReceipt
}

export type DestroyCapsuleAbandonedClassificationResult = DestroyCapsuleTerminalResult | null

/**
 * Immutable branch provenance establishes the managed footprint independently
 * from the success or failure of the operation that attempted to create it.
 */
export interface DestroyBranchProof {
  branch: DestroyBranch
  origin: DestroyOperation
  blueprint: CapsuleBlueprintPin
  sourceSnapshotId: string | null
}

/**
 * Ordering is derived from immutable fork dependencies during this invocation.
 * The durable plan independently binds the complete, unordered target set.
 */
export interface DestroyPlan {
  document: CapsuleDestroyPlan
  ordered: CapsuleDestroyResourcePlan[]
}

export interface DestroyExecution {
  operationId: string
  ownerId: string
  capsuleId: string
  force: boolean
  targets: DestroyTarget[]
}
