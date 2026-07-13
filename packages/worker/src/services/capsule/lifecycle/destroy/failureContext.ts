import { createLifecycleOperationFailureContext, type LifecycleOperationFailureContextInput } from '../../lifecycleLedger/errors'
import { detailsFromUnknown, failureCodeFromUnknown, failureMessageFromUnknown } from '../../stores/errorDetails'
import { CapsuleDestroyStepKey } from './stepKeys'

export const CapsuleDestroyFailurePhase = {
  ACCEPT_DESTROY: 'accept_destroy',
  PLAN_DESTROY: CapsuleDestroyStepKey.PLAN_DESTROY,
  DELETE_BRANCH_INSTANCES: CapsuleDestroyStepKey.DELETE_BRANCH_INSTANCES,
  DELETE_BRANCH_VOLUMES: CapsuleDestroyStepKey.DELETE_BRANCH_VOLUMES,
  FINALIZE_DERIVED_RESOURCE_OUTCOMES: CapsuleDestroyStepKey.FINALIZE_DERIVED_RESOURCE_OUTCOMES,
  VERIFY_TERMINAL_RESOURCE_OUTCOMES: CapsuleDestroyStepKey.VERIFY_TERMINAL_RESOURCE_OUTCOMES,
  FINALIZE_DESTROYED_AGGREGATE: 'finalize_destroyed_aggregate',
} as const

export type CapsuleDestroyFailurePhase = (typeof CapsuleDestroyFailurePhase)[keyof typeof CapsuleDestroyFailurePhase]

export interface CapsuleDestroyOperationFailureContextInput extends LifecycleOperationFailureContextInput {
  aggregateDestroyed?: boolean
  branchCount?: number
  instanceCount?: number
  volumeCount?: number
  provisioningFileCount?: number
}

export interface CapsuleDestroyProviderFailureDetailInput {
  action: string
  error: unknown
  branchId: string
  branchName: string
  resourceId: string
  resourceKey: string
}

export interface CapsuleDestroyProviderFailureDetail {
  phase: typeof CapsuleDestroyFailurePhase.DELETE_BRANCH_INSTANCES | typeof CapsuleDestroyFailurePhase.DELETE_BRANCH_VOLUMES
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

/**
 * Extends shared lifecycle failure vocabulary with destroy-specific aggregate
 * and planned-resource facts.
 */
export function createCapsuleDestroyOperationFailureContext(input: CapsuleDestroyOperationFailureContextInput): Record<string, unknown> {
  const context = createLifecycleOperationFailureContext(input)

  assignIfDefined(context, 'aggregateDestroyed', input.aggregateDestroyed)
  assignIfDefined(context, 'branchCount', input.branchCount)
  assignIfDefined(context, 'instanceCount', input.instanceCount)
  assignIfDefined(context, 'volumeCount', input.volumeCount)
  assignIfDefined(context, 'provisioningFileCount', input.provisioningFileCount)

  return context
}

export function createCapsuleDestroyProviderFailureDetail(
  phase: typeof CapsuleDestroyFailurePhase.DELETE_BRANCH_INSTANCES | typeof CapsuleDestroyFailurePhase.DELETE_BRANCH_VOLUMES,
  input: CapsuleDestroyProviderFailureDetailInput,
): CapsuleDestroyProviderFailureDetail {
  const detail: CapsuleDestroyProviderFailureDetail = {
    phase,
    action: input.action,
    code: failureCodeFromUnknown(input.error),
    message: failureMessageFromUnknown(input.error, 'Unknown capsule destroy provider failure.'),
    branchId: input.branchId,
    branchName: input.branchName,
    resourceId: input.resourceId,
    resourceKey: input.resourceKey,
  }
  const details = detailsFromUnknown(input.error)
  if (details !== undefined) {
    detail.details = details
  }
  return detail
}
