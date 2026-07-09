import { CapsuleBranchCreateStepKey } from './branch/create/steps'
import { detailsFromUnknown, failureCodeFromUnknown, failureMessageFromUnknown } from '../stores/errorDetails'

export const CapsuleBranchCreateFailurePhase = {
  PLAN_RESOURCES: CapsuleBranchCreateStepKey.PLAN_RESOURCES,
  ENSURE_NAMESPACE: CapsuleBranchCreateStepKey.ENSURE_NAMESPACE,
  RECORD_BIND_MOUNTS: CapsuleBranchCreateStepKey.RECORD_BIND_MOUNTS,
  CREATE_VOLUMES: CapsuleBranchCreateStepKey.CREATE_VOLUMES,
  CREATE_INSTANCE: CapsuleBranchCreateStepKey.CREATE_INSTANCE,
  WRITE_PROVISIONING_FILES: CapsuleBranchCreateStepKey.WRITE_PROVISIONING_FILES,
  FINALIZE_BRANCH_OFFLINE: CapsuleBranchCreateStepKey.FINALIZE_BRANCH_OFFLINE,
  COMPLETE_OPERATION: 'complete_operation',
  COMPENSATION: 'compensation',
} as const

export type CapsuleBranchCreateFailurePhase = (typeof CapsuleBranchCreateFailurePhase)[keyof typeof CapsuleBranchCreateFailurePhase]

export const CapsuleCompensationStatus = {
  NOT_ATTEMPTED: 'not_attempted',
  SKIPPED: 'skipped',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const

export type CapsuleCompensationStatus = (typeof CapsuleCompensationStatus)[keyof typeof CapsuleCompensationStatus]

export interface CapsuleCompensationFailureDetail {
  phase: typeof CapsuleBranchCreateFailurePhase.COMPENSATION
  action: string
  code: string
  message: string
  resourceId?: string
  resourceKey?: string
  details?: Record<string, unknown>
}

export interface CapsuleCompensationResult {
  hadFailure: boolean
  failures: CapsuleCompensationFailureDetail[]
}

export interface OperationFailureContextInput {
  operationId?: string
  branchName?: string
  phase?: string
  stepKey?: string | null
  branchFinalized?: boolean
  action?: string
  resourceId?: string
  resourceKey?: string
  compensationStatus?: CapsuleCompensationStatus
  compensationFailures?: readonly CapsuleCompensationFailureDetail[]
}

export interface CompensationFailureDetailInput {
  action: string
  error: unknown
  resourceId?: string
  resourceKey?: string
}

export type CapsuleOperationStepPersistenceTransition = 'ensure' | 'running' | 'completed' | 'failed'

export interface CapsuleOperationStepPersistenceErrorOptions {
  stepKey: string
  transition: CapsuleOperationStepPersistenceTransition
  error: unknown
  stepId?: string
}

export class CapsuleOperationStepPersistenceError extends Error {
  public readonly code = 'STEP_PERSISTENCE_ERROR'
  public readonly details: Record<string, unknown>
  public readonly originalError: unknown

  constructor(message: string, options: CapsuleOperationStepPersistenceErrorOptions) {
    super(message)
    this.name = 'CapsuleOperationStepPersistenceError'
    this.originalError = options.error
    const details: Record<string, unknown> = {
      stepKey: options.stepKey,
      transition: options.transition,
      originalError: detailsFromUnknown(options.error) ?? {
        message: 'Unknown step persistence error.',
      },
    }
    if (options.stepId !== undefined) {
      details.stepId = options.stepId
    }
    this.details = details
  }
}

export class CapsuleAbandonedOperationError extends Error {
  public readonly code = 'ABANDONED_INLINE_OPERATION'
  public readonly details: Record<string, unknown>
  constructor(message: string, details: Record<string, unknown>) {
    super(message)
    this.name = 'CapsuleAbandonedOperationError'
    this.details = details
  }
}

function assignIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value
  }
}

/**
 * Creates JSON-safe context to persist alongside the normalized error.
 *
 * The stores own the final failure envelope. This helper only keeps operation
 * callers consistent about phase/action/resource vocabulary.
 */
export function createOperationFailureContext(input: OperationFailureContextInput): Record<string, unknown> {
  const context: Record<string, unknown> = {}
  assignIfDefined(context, 'operationId', input.operationId)
  assignIfDefined(context, 'branchName', input.branchName)
  assignIfDefined(context, 'phase', input.phase)
  assignIfDefined(context, 'stepKey', input.stepKey)
  assignIfDefined(context, 'branchFinalized', input.branchFinalized)
  assignIfDefined(context, 'action', input.action)
  assignIfDefined(context, 'resourceId', input.resourceId)
  assignIfDefined(context, 'resourceKey', input.resourceKey)
  assignIfDefined(context, 'compensationStatus', input.compensationStatus)
  if (input.compensationFailures && input.compensationFailures.length > 0) {
    context.compensationFailures = input.compensationFailures
  }
  return context
}

export function createCompensationFailureDetail(input: CompensationFailureDetailInput): CapsuleCompensationFailureDetail {
  const detail: CapsuleCompensationFailureDetail = {
    phase: CapsuleBranchCreateFailurePhase.COMPENSATION,
    action: input.action,
    code: failureCodeFromUnknown(input.error),
    message: failureMessageFromUnknown(input.error, 'Unknown compensation failure.'),
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
