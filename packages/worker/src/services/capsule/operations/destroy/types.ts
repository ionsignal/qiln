import type {
  CapsuleActorReference,
  CapsuleDestroyOptions,
  CapsuleDestroyOptionsInput,
  CapsuleDestroyReceipt,
  CapsuleLifecycleState,
  CapsuleOperationRequestHash,
  CapsuleTables,
} from '@qiln/core/server'
import type { CapsuleOperationTransitionOutput } from '../shared'

export type DestroyOperation = CapsuleTables['capsuleOperations']['$inferSelect']
export type DestroyCapsule = CapsuleTables['capsules']['$inferSelect']
export type DestroyBranch = CapsuleTables['capsuleBranches']['$inferSelect']
export type DestroyResource = CapsuleTables['capsuleBranchResources']['$inferSelect']

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

interface DestroyTarget {
  id: string
  branchId: string
  branchName: string
  resourceKey: string
  namespace: string
}

export interface DestroyInstance extends DestroyTarget {
  kind: 'instance'
  instanceName: string
}

export interface DestroyVolume extends DestroyTarget {
  kind: 'volume'
  pool: string
  volumeName: string
}

export type DestroyProviderTarget = DestroyInstance | DestroyVolume

export interface DestroyFile {
  id: string
  branchId: string
  backingResourceId: string
}

export interface DestroyPlan {
  instances: DestroyInstance[]
  volumes: DestroyVolume[]
  files: DestroyFile[]
  branchCount: number
  providerRequired: boolean
}

export interface DestroyExecution {
  operationId: string
  ownerId: string
  capsuleId: string
  force: boolean
  plan: DestroyPlan
  withdrawPreviews: boolean
}
