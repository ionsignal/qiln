import { detailsFromUnknown } from '../stores/errorDetails'

export interface LifecycleOperationFailureContextInput {
  operationId?: string
  capsuleId?: string
  branchId?: string
  branchName?: string
  phase?: string
  stepKey?: string | null
  branchFinalized?: boolean
  aggregateFinalized?: boolean
  action?: string
  resourceId?: string
  resourceKey?: string
  resourceOwnershipUncertain?: boolean
}

export type CapsuleLifecycleStepPersistenceTransition = 'ensure' | 'running' | 'completed' | 'failed'

export interface CapsuleLifecycleStepPersistenceErrorOptions {
  stepKey: string
  transition: CapsuleLifecycleStepPersistenceTransition
  error: unknown
  stepId?: string
}

/**
 * Represents failure to persist one of the durable accounting fences around an
 * inline capsule lifecycle step. Callers must fail closed rather than continue
 * with an unrecorded provider mutation or operation phase.
 */
export class CapsuleLifecycleStepPersistenceError extends Error {
  public readonly code = 'LIFECYCLE_STEP_PERSISTENCE_ERROR'
  public readonly details: Record<string, unknown>
  public readonly originalError: unknown

  constructor(message: string, options: CapsuleLifecycleStepPersistenceErrorOptions) {
    super(message)
    this.name = 'CapsuleLifecycleStepPersistenceError'
    this.originalError = options.error
    const details: Record<string, unknown> = {
      stepKey: options.stepKey,
      transition: options.transition,
      originalError: detailsFromUnknown(options.error) ?? {
        message: 'Unknown lifecycle step persistence error.',
      },
    }
    if (options.stepId !== undefined) {
      details.stepId = options.stepId
    }
    this.details = details
  }
}

/**
 * Marks a non-terminal inline lifecycle operation discovered after a Worker
 * shutdown or crash. Qiln records the operation as cleanup-required and never
 * resumes its mutation steps.
 */
export class CapsuleAbandonedLifecycleOperationError extends Error {
  public readonly code = 'ABANDONED_INLINE_LIFECYCLE_OPERATION'
  public readonly details: Record<string, unknown>

  constructor(message: string, details: Record<string, unknown>) {
    super(message)
    this.name = 'CapsuleAbandonedLifecycleOperationError'
    this.details = details
  }
}

function assignIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value
  }
}

/**
 * Creates JSON-safe contextual vocabulary shared by durable capsule lifecycle
 * operations. Bootstrap and destroy may add operation-specific details.
 */
export function createLifecycleOperationFailureContext(input: LifecycleOperationFailureContextInput): Record<string, unknown> {
  const context: Record<string, unknown> = {}

  assignIfDefined(context, 'operationId', input.operationId)
  assignIfDefined(context, 'capsuleId', input.capsuleId)
  assignIfDefined(context, 'branchId', input.branchId)
  assignIfDefined(context, 'branchName', input.branchName)
  assignIfDefined(context, 'phase', input.phase)
  assignIfDefined(context, 'stepKey', input.stepKey)
  assignIfDefined(context, 'branchFinalized', input.branchFinalized)
  assignIfDefined(context, 'aggregateFinalized', input.aggregateFinalized)
  assignIfDefined(context, 'action', input.action)
  assignIfDefined(context, 'resourceId', input.resourceId)
  assignIfDefined(context, 'resourceKey', input.resourceKey)
  assignIfDefined(context, 'resourceOwnershipUncertain', input.resourceOwnershipUncertain)

  return context
}
