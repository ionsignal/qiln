import { CapsuleOperationStatus, CapsuleOperationTypeValues, type CapsuleOperationTypeValue } from '@qiln/core/server'
import type { CapsuleOperationTransitionOutput, PersistedCapsuleOperation } from '../shared'

const LOGGER_PREFIX = '[CapsuleOperationAbandonment]'

/**
 * Result returned by one operation-local abandonment handler.
 *
 * `classified: true` means the operation-specific repository committed a
 * terminal classification transaction. The returned transition is then
 * available for shared post-classification accounting.
 *
 * Operation-specific invalidations must already have been published from
 * committed repository output before the handler returns this result.
 */
export type CapsuleOperationAbandonmentClassificationResult =
  | {
      readonly classified: false
    }
  | {
      readonly classified: true
      readonly operation: CapsuleOperationTransitionOutput
    }

/**
 * Operation-local adapter for startup abandonment classification.
 *
 * Implementations own:
 *
 * - operation-type validation;
 * - invocation of the operation-specific repository;
 * - committed result identity validation;
 * - publication of operation-specific invalidations.
 *
 * Implementations must not invoke an executor, retry provider work, resume an
 * operation step, or infer classification from process-local state.
 */
export interface CapsuleOperationAbandonmentHandler {
  readonly operationType: CapsuleOperationTypeValue

  classify(operation: PersistedCapsuleOperation): Promise<CapsuleOperationAbandonmentClassificationResult>
}

/**
 * Narrows a discovered operation to the type owned by one abandonment handler.
 *
 * Every operation-local handler should call this before invoking its repository
 * so incorrect registry wiring fails before classification or event
 * publication.
 */
export function assertAbandonedOperationType<TOperationType extends CapsuleOperationTypeValue>(
  operation: PersistedCapsuleOperation,
  expectedOperationType: TOperationType,
): asserts operation is PersistedCapsuleOperation & {
  type: TOperationType
} {
  if (operation.type === expectedOperationType) {
    return
  }
  throw new Error(`${LOGGER_PREFIX} Handler for '${expectedOperationType}' received operation '${operation.id}' of type '${operation.type}'.`)
}

/**
 * Verifies that an operation-specific repository classified the same durable
 * operation that was discovered by startup coordination.
 *
 * This assertion must run before operation-specific invalidations are
 * published. A repository or adapter wiring defect must never publish state
 * changes for a different owner, capsule, operation, or operation type.
 */
export function assertAbandonedOperationTransitionIdentity(
  discoveredOperation: PersistedCapsuleOperation,
  committedOperation: CapsuleOperationTransitionOutput,
): void {
  const mismatches: string[] = []
  if (committedOperation.operationId !== discoveredOperation.id) {
    mismatches.push('operationId')
  }
  if (committedOperation.ownerId !== discoveredOperation.ownerId) {
    mismatches.push('ownerId')
  }
  if (committedOperation.capsuleId !== discoveredOperation.capsuleId) {
    mismatches.push('capsuleId')
  }
  if (committedOperation.operationType !== discoveredOperation.type) {
    mismatches.push('operationType')
  }
  if (mismatches.length === 0) {
    return
  }
  throw new Error(
    [
      `${LOGGER_PREFIX} Operation-specific handler returned a committed classification for the wrong durable operation identity.`,
      `Mismatched fields: ${mismatches.join(', ')}.`,
      `Discovered operation: ${discoveredOperation.id} (${discoveredOperation.type}), owner ${discoveredOperation.ownerId}, capsule ${discoveredOperation.capsuleId}.`,
      `Committed operation: ${committedOperation.operationId} (${committedOperation.operationType}), owner ${committedOperation.ownerId}, capsule ${committedOperation.capsuleId}.`,
    ].join(' '),
  )
}

/**
 * Ensures a successful abandonment classification committed a terminal
 * operation state before any invalidation is published.
 */
export function assertAbandonedOperationTransitionTerminal(committedOperation: CapsuleOperationTransitionOutput): void {
  if (
    committedOperation.operationStatus !== CapsuleOperationStatus.ACCEPTED &&
    committedOperation.operationStatus !== CapsuleOperationStatus.RUNNING
  ) {
    return
  }
  throw new Error(
    `${LOGGER_PREFIX} Abandonment classification for operation '${committedOperation.operationId}' returned nonterminal status '${committedOperation.operationStatus}'.`,
  )
}

/**
 * Immutable registry of operation-local abandonment handlers.
 *
 * Registration is fixed at construction time so startup classification cannot
 * observe a partially mutated handler set. Duplicate registrations fail
 * immediately. Full operation-type coverage is validated explicitly by
 * `assertComplete()` at the startup coordination boundary.
 */
export class CapsuleOperationAbandonmentHandlerRegistry {
  private readonly handlers = new Map<CapsuleOperationTypeValue, CapsuleOperationAbandonmentHandler>()

  constructor(handlers: readonly CapsuleOperationAbandonmentHandler[]) {
    for (const handler of handlers) {
      this.register(handler)
    }
  }

  /**
   * Resolves the handler responsible for one durable operation type.
   *
   * A missing handler is a fatal startup configuration error. Allowing startup
   * to continue would leave an existing mutation fence unclassified while new
   * operation intake becomes available.
   */
  public require(operationType: CapsuleOperationTypeValue): CapsuleOperationAbandonmentHandler {
    const handler = this.handlers.get(operationType)
    if (!handler) {
      throw new Error(`${LOGGER_PREFIX} No startup abandonment handler is registered for operation type '${operationType}'.`)
    }
    return handler
  }

  /**
   * Proves that every durable operation type has an abandonment policy.
   *
   * This should be called before any abandoned operation is dispatched. It
   * detects newly introduced operation types even when no nonterminal row of
   * that type currently exists.
   */
  public assertComplete(): void {
    const missingOperationTypes = CapsuleOperationTypeValues.filter(operationType => !this.handlers.has(operationType))
    if (missingOperationTypes.length === 0) {
      return
    }
    throw new Error(`${LOGGER_PREFIX} Startup abandonment handlers are missing for operation types: ${missingOperationTypes.join(', ')}.`)
  }

  private register(handler: CapsuleOperationAbandonmentHandler): void {
    if (!CapsuleOperationTypeValues.includes(handler.operationType)) {
      throw new Error(`${LOGGER_PREFIX} Cannot register a handler for unsupported operation type '${handler.operationType}'.`)
    }
    if (this.handlers.has(handler.operationType)) {
      throw new Error(`${LOGGER_PREFIX} Duplicate startup abandonment handler registered for operation type '${handler.operationType}'.`)
    }
    this.handlers.set(handler.operationType, handler)
  }
}
