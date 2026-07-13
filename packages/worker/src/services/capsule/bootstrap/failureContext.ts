import { BootstrapStepKey } from './stepKeys'
import { createLifecycleOperationFailureContext, type LifecycleOperationFailureContextInput } from '../lifecycleLedger/errors'
import { detailsFromUnknown, failureCodeFromUnknown, failureMessageFromUnknown } from '../stores/errorDetails'

export const BootstrapFailurePhase = {
  PLAN_RESOURCES: BootstrapStepKey.PLAN_RESOURCES,
  RECORD_RESOURCE_INVENTORY: BootstrapStepKey.RECORD_RESOURCE_INVENTORY,
  ENSURE_NAMESPACE: BootstrapStepKey.ENSURE_NAMESPACE,
  RECORD_BIND_MOUNTS: BootstrapStepKey.RECORD_BIND_MOUNTS,
  CREATE_VOLUMES: BootstrapStepKey.CREATE_VOLUMES,
  CREATE_INSTANCE: BootstrapStepKey.CREATE_INSTANCE,
  WRITE_PROVISIONING_FILES: BootstrapStepKey.WRITE_PROVISIONING_FILES,
  FINALIZE_BRANCH_OFFLINE: BootstrapStepKey.FINALIZE_BRANCH_OFFLINE,
  COMPLETE_OPERATION: 'complete_operation',
  COMPENSATION: 'compensation',
  FINALIZE_COMPENSATED_BOOTSTRAP: 'finalize_compensated_bootstrap',
} as const

export type BootstrapFailurePhase = (typeof BootstrapFailurePhase)[keyof typeof BootstrapFailurePhase]

export const BootstrapCompensationStatus = {
  NOT_ATTEMPTED: 'not_attempted',
  SKIPPED: 'skipped',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const

export type BootstrapCompensationStatus = (typeof BootstrapCompensationStatus)[keyof typeof BootstrapCompensationStatus]

export const BootstrapCompensatedBranchRemovalStatus = {
  NOT_ATTEMPTED: 'not_attempted',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const

export type BootstrapCompensatedBranchRemovalStatus =
  (typeof BootstrapCompensatedBranchRemovalStatus)[keyof typeof BootstrapCompensatedBranchRemovalStatus]

export interface BootstrapCompensationFailureDetail {
  phase: typeof BootstrapFailurePhase.COMPENSATION
  action: string
  code: string
  message: string
  resourceId?: string
  resourceKey?: string
  details?: Record<string, unknown>
}

export interface BootstrapCompensatedBranchRemovalFailureDetail {
  phase: typeof BootstrapFailurePhase.FINALIZE_COMPENSATED_BOOTSTRAP
  action: string
  code: string
  message: string
  branchId: string
  details?: Record<string, unknown>
}

export interface BootstrapOperationFailureContextInput extends LifecycleOperationFailureContextInput {
  compensationStatus?: BootstrapCompensationStatus
  compensationFailures?: readonly BootstrapCompensationFailureDetail[]
  compensatedBranchRemovalStatus?: BootstrapCompensatedBranchRemovalStatus
  compensatedBranchRemovalFailure?: BootstrapCompensatedBranchRemovalFailureDetail
}

export interface BootstrapCompensationFailureDetailInput {
  action: string
  error: unknown
  resourceId?: string
  resourceKey?: string
}

export interface BootstrapBranchFinalizationFailureDetailInput {
  action: string
  branchId: string
  error: unknown
}

function assignIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value
  }
}

/**
 * Adds bootstrap-specific compensation details without teaching the shared lifecycle ledger about root capsule initialization.
 */
export function createBootstrapOperationFailureContext(input: BootstrapOperationFailureContextInput): Record<string, unknown> {
  const context = createLifecycleOperationFailureContext(input)
  assignIfDefined(context, 'compensationStatus', input.compensationStatus)
  if (input.compensationFailures && input.compensationFailures.length > 0) {
    context.compensationFailures = input.compensationFailures
  }
  assignIfDefined(context, 'compensatedBranchRemovalStatus', input.compensatedBranchRemovalStatus)
  assignIfDefined(context, 'compensatedBranchRemovalFailure', input.compensatedBranchRemovalFailure)
  return context
}

export function createBootstrapCompensationFailureDetail(input: BootstrapCompensationFailureDetailInput): BootstrapCompensationFailureDetail {
  const detail: BootstrapCompensationFailureDetail = {
    phase: BootstrapFailurePhase.COMPENSATION,
    action: input.action,
    code: failureCodeFromUnknown(input.error),
    message: failureMessageFromUnknown(input.error, 'Unknown bootstrap compensation failure.'),
  }
  if (input.resourceId !== undefined) {
    detail.resourceId = input.resourceId
  }
  if (input.resourceKey !== undefined) {
    detail.resourceKey = input.resourceKey
  }
  const details = detailsFromUnknown(input.error)
  if (details !== undefined) {
    detail.details = details
  }
  return detail
}

export function createBootstrapCompensatedBranchRemovalFailureDetail(
  input: BootstrapBranchFinalizationFailureDetailInput,
): BootstrapCompensatedBranchRemovalFailureDetail {
  const detail: BootstrapCompensatedBranchRemovalFailureDetail = {
    phase: BootstrapFailurePhase.FINALIZE_COMPENSATED_BOOTSTRAP,
    action: input.action,
    branchId: input.branchId,
    code: failureCodeFromUnknown(input.error),
    message: failureMessageFromUnknown(input.error, 'Unknown compensated bootstrap finalization failure.'),
  }
  const details = detailsFromUnknown(input.error)
  if (details !== undefined) {
    detail.details = details
  }
  return detail
}
