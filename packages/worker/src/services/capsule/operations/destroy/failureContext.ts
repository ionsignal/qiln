import {
  failureCodeFromUnknown as operationFailureCodeFromUnknown,
  failureMessageFromUnknown as operationFailureMessageFromUnknown,
  normalizeFailureDetails as operationFailureDetailsFromUnknown,
} from '../../failures'
import { DestroyCapsuleStepKey } from './stepKeys'

export const DestroyCapsuleFailurePhase = {
  PLAN_DESTROY: DestroyCapsuleStepKey.PLAN_DESTROY,
  COMMIT_PROVIDER_INTENT_FENCE: 'commit_provider_intent_fence',
  DELETE_BRANCH_INSTANCES: DestroyCapsuleStepKey.DELETE_BRANCH_INSTANCES,
  DELETE_BRANCH_VOLUMES: DestroyCapsuleStepKey.DELETE_BRANCH_VOLUMES,
  FINALIZE_DERIVED_RESOURCE_OUTCOMES: DestroyCapsuleStepKey.FINALIZE_DERIVED_RESOURCE_OUTCOMES,
  VERIFY_TERMINAL_RESOURCE_OUTCOMES: DestroyCapsuleStepKey.VERIFY_TERMINAL_RESOURCE_OUTCOMES,
  COMPLETE_DESTROY: 'complete_destroy',
  FAIL_BEFORE_PROVIDER_MUTATION: 'fail_before_provider_mutation',
  REQUIRE_CLEANUP: 'require_cleanup',
} as const

export type DestroyCapsuleFailurePhase = (typeof DestroyCapsuleFailurePhase)[keyof typeof DestroyCapsuleFailurePhase]

export interface DestroyCapsuleFailureContextInput {
  operationId: string
  capsuleId: string
  phase: DestroyCapsuleFailurePhase
  failedPhase?: DestroyCapsuleFailurePhase
  stepKey?: DestroyCapsuleStepKey | null
  action?: string
  branchId?: string
  branchName?: string
  resourceId?: string
  resourceKey?: string
  providerIntentCommitted?: boolean
  providerOwnershipUncertain?: boolean
  aggregateCompletionCommitted?: boolean
  branchCount?: number
  instanceCount?: number
  volumeCount?: number
  provisioningFileCount?: number
}

export interface DestroyCapsuleProviderFailureInput {
  phase: typeof DestroyCapsuleFailurePhase.DELETE_BRANCH_INSTANCES | typeof DestroyCapsuleFailurePhase.DELETE_BRANCH_VOLUMES
  action: string
  error: unknown
  branchId: string
  branchName: string
  resourceId: string
  resourceKey: string
}

export interface DestroyCapsuleProviderFailure {
  phase: typeof DestroyCapsuleFailurePhase.DELETE_BRANCH_INSTANCES | typeof DestroyCapsuleFailurePhase.DELETE_BRANCH_VOLUMES
  action: string
  code: string
  message: string
  branchId: string
  branchName: string
  resourceId: string
  resourceKey: string
  details?: Record<string, unknown>
}

function assignIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value
  }
}

export function createDestroyCapsuleFailureContext(input: DestroyCapsuleFailureContextInput): Record<string, unknown> {
  const context: Record<string, unknown> = {
    operationId: input.operationId,
    capsuleId: input.capsuleId,
    phase: input.phase,
  }

  assignIfDefined(context, 'failedPhase', input.failedPhase)
  assignIfDefined(context, 'stepKey', input.stepKey)
  assignIfDefined(context, 'action', input.action)
  assignIfDefined(context, 'branchId', input.branchId)
  assignIfDefined(context, 'branchName', input.branchName)
  assignIfDefined(context, 'resourceId', input.resourceId)
  assignIfDefined(context, 'resourceKey', input.resourceKey)
  assignIfDefined(context, 'providerIntentCommitted', input.providerIntentCommitted)
  assignIfDefined(context, 'providerOwnershipUncertain', input.providerOwnershipUncertain)
  assignIfDefined(context, 'aggregateCompletionCommitted', input.aggregateCompletionCommitted)
  assignIfDefined(context, 'branchCount', input.branchCount)
  assignIfDefined(context, 'instanceCount', input.instanceCount)
  assignIfDefined(context, 'volumeCount', input.volumeCount)
  assignIfDefined(context, 'provisioningFileCount', input.provisioningFileCount)

  return context
}

export function createDestroyCapsuleProviderFailure(input: DestroyCapsuleProviderFailureInput): DestroyCapsuleProviderFailure {
  const failure: DestroyCapsuleProviderFailure = {
    phase: input.phase,
    action: input.action,
    code: operationFailureCodeFromUnknown(input.error),
    message: operationFailureMessageFromUnknown(input.error, 'Unknown capsule destroy provider failure.'),
    branchId: input.branchId,
    branchName: input.branchName,
    resourceId: input.resourceId,
    resourceKey: input.resourceKey,
  }

  const details = operationFailureDetailsFromUnknown(input.error)

  if (details !== undefined) {
    failure.details = details
  }

  return failure
}
