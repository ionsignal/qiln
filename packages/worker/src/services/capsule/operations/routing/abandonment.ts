import { CapsuleOperationType } from '@qiln/core/server'
import {
  assertAbandonedOperationTransitionIdentity,
  assertAbandonedOperationTransitionTerminal,
  assertAbandonedOperationType,
  type CapsuleOperationAbandonmentClassificationResult,
  type CapsuleOperationAbandonmentHandler,
} from '../abandonment'
import type { CapsuleOperationEventPublisher, CapsuleRouteEventPublisher } from '../../events'
import type { PersistedCapsuleOperation } from '../shared'
import type { RouteOperationAbandonmentClassifier, RouteOperationType } from './classification'

export interface RouteOperationAbandonmentDependencies {
  classifier: RouteOperationAbandonmentClassifier
  operationEvents: CapsuleOperationEventPublisher
  routeEvents: CapsuleRouteEventPublisher
}

/**
 * Applies promote or rollback startup abandonment policy without reapplying
 * Caddy configuration or resuming provider work.
 */
export class RouteOperationAbandonment implements CapsuleOperationAbandonmentHandler {
  constructor(
    public readonly operationType: RouteOperationType,
    private readonly dependencies: RouteOperationAbandonmentDependencies,
  ) {}

  public async classify(
    operation: PersistedCapsuleOperation,
  ): Promise<CapsuleOperationAbandonmentClassificationResult> {
    assertAbandonedOperationType(operation, this.operationType)
    const result = await this.dependencies.classifier.classify(operation.id, this.operationType)
    if (!result) {
      return {
        classified: false,
      }
    }
    assertAbandonedOperationTransitionIdentity(operation, result.operation)
    assertAbandonedOperationTransitionTerminal(result.operation)
    this.dependencies.operationEvents.publishChanged(result.operation)
    if (result.route) {
      this.dependencies.routeEvents.changed(result.operation.ownerId, result.route)
    }
    return {
      classified: true,
      operation: result.operation,
    }
  }
}

export function createRouteOperationAbandonmentHandlers(
  dependencies: RouteOperationAbandonmentDependencies,
): readonly RouteOperationAbandonment[] {
  return [
    new RouteOperationAbandonment(CapsuleOperationType.PROMOTE, dependencies),
    new RouteOperationAbandonment(CapsuleOperationType.ROLLBACK, dependencies),
  ]
}
