import {
  failureCodeFromUnknown as operationFailureCodeFromUnknown,
  failureMessageFromUnknown as operationFailureMessageFromUnknown,
  normalizeFailureDetails as operationFailureDetailsFromUnknown,
} from '../../failures'
import { CreateCapsuleStepKey } from './stepKeys'

export const CreateCapsuleFailurePhase = {
  LOAD_EXECUTION_INPUT: 'load_execution_input',
  CLAIM_OPERATION: 'claim_operation',
  PLAN_RESOURCES: CreateCapsuleStepKey.PLAN_RESOURCES,
  RECORD_RESOURCE_INVENTORY: CreateCapsuleStepKey.RECORD_RESOURCE_INVENTORY,
  VERIFY_ROOTFS_IMAGE: CreateCapsuleStepKey.VERIFY_ROOTFS_IMAGE,
  COMMIT_PROVIDER_INTENT_FENCE: 'commit_provider_intent_fence',
  ENSURE_NAMESPACE: CreateCapsuleStepKey.ENSURE_NAMESPACE,
  RECORD_BIND_MOUNTS: CreateCapsuleStepKey.RECORD_BIND_MOUNTS,
  CREATE_VOLUMES: CreateCapsuleStepKey.CREATE_VOLUMES,
  CREATE_INSTANCE: CreateCapsuleStepKey.CREATE_INSTANCE,
  WRITE_PROVISIONING_FILES: CreateCapsuleStepKey.WRITE_PROVISIONING_FILES,
  COMPLETE_CREATE: CreateCapsuleStepKey.COMPLETE_CREATE,
  COMPENSATION: 'compensation',
  FAIL_BEFORE_PROVIDER_MUTATION: 'fail_before_provider_mutation',
  FAIL_AFTER_SUCCESSFUL_COMPENSATION: 'fail_after_successful_compensation',
  MARK_CLEANUP_REQUIRED: 'mark_cleanup_required',
} as const

export type CreateCapsuleFailurePhase = (typeof CreateCapsuleFailurePhase)[keyof typeof CreateCapsuleFailurePhase]

export interface CreateCapsuleFailureContextInput {
  operationId: string
  capsuleId?: string
  rootBranchId?: string
  rootBranchName?: string
  phase: CreateCapsuleFailurePhase
  failedPhase?: CreateCapsuleFailurePhase
  stepKey?: CreateCapsuleStepKey | null
  action?: string
  resourceId?: string
  resourceKey?: string
  providerIntentCommitted?: boolean
  providerOwnershipUncertain?: boolean
  completionCommitted?: boolean
  compensationAttempted?: boolean
  compensationCompleted?: boolean
  compensationFailures?: readonly CreateCapsuleCompensationFailure[]
}

export interface CreateCapsuleCompensationFailure {
  phase: typeof CreateCapsuleFailurePhase.COMPENSATION
  action: string
  code: string
  message: string
  resourceId: string
  resourceKey: string
  details?: Record<string, unknown>
}

function assignIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value
  }
}

export function createCreateCapsuleFailureContext(input: CreateCapsuleFailureContextInput): Record<string, unknown> {
  const context: Record<string, unknown> = {
    operationId: input.operationId,
    phase: input.phase,
  }

  assignIfDefined(context, 'capsuleId', input.capsuleId)
  assignIfDefined(context, 'rootBranchId', input.rootBranchId)
  assignIfDefined(context, 'rootBranchName', input.rootBranchName)
  assignIfDefined(context, 'failedPhase', input.failedPhase)
  assignIfDefined(context, 'stepKey', input.stepKey)
  assignIfDefined(context, 'action', input.action)
  assignIfDefined(context, 'resourceId', input.resourceId)
  assignIfDefined(context, 'resourceKey', input.resourceKey)
  assignIfDefined(context, 'providerIntentCommitted', input.providerIntentCommitted)
  assignIfDefined(context, 'providerOwnershipUncertain', input.providerOwnershipUncertain)
  assignIfDefined(context, 'completionCommitted', input.completionCommitted)
  assignIfDefined(context, 'compensationAttempted', input.compensationAttempted)
  assignIfDefined(context, 'compensationCompleted', input.compensationCompleted)

  if (input.compensationFailures && input.compensationFailures.length > 0) {
    context.compensationFailures = input.compensationFailures
  }

  return context
}

export function createCreateCapsuleCompensationFailure(input: {
  action: string
  error: unknown
  resourceId: string
  resourceKey: string
}): CreateCapsuleCompensationFailure {
  const failure: CreateCapsuleCompensationFailure = {
    phase: CreateCapsuleFailurePhase.COMPENSATION,
    action: input.action,
    code: operationFailureCodeFromUnknown(input.error),
    message: operationFailureMessageFromUnknown(input.error, 'Unknown capsule create compensation failure.'),
    resourceId: input.resourceId,
    resourceKey: input.resourceKey,
  }

  const details = operationFailureDetailsFromUnknown(input.error)

  if (details !== undefined) {
    failure.details = details
  }

  return failure
}
