import { and, asc, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError } from '../../../../../errors'
import {
  createFailureDetails as createOperationFailureDetails,
  failureCodeFromUnknown as operationFailureCodeFromUnknown,
  failureMessageFromUnknown as operationFailureMessageFromUnknown,
} from '../../../failures'
import { toCapsuleLifecycleState, toCapsuleOperationTransition, type CapsuleOperationReader } from '../../shared'
import { toJsonObject } from '../../../persistence/json'
import {
  decideDestroyNonterminalFailure,
  inspectDestroyOperationTerminality,
  isDestroyNonterminalOperationStatus,
} from '../policy/failure'
import { inspectDestroyCapsuleBranchLineage } from '../policy/lineage'
import {
  lockDestroyCapsuleBranches,
  lockDestroyOperation,
  lockOwnedDestroyCapsule,
  type PersistedDestroyCapsule,
  type PersistedDestroyOperation,
} from './locks'
import type {
  DestroyCapsuleAbandonedClassificationResult,
  DestroyCapsuleAcceptedBranch,
  DestroyCapsuleTerminalResult,
} from '../types'

const NONTERMINAL_DESTROY_STATUSES = [CapsuleOperationStatus.ACCEPTED, CapsuleOperationStatus.RUNNING] as const

/**
 * Owns destroy-specific persistence orchestration for live execution failures
 * and startup abandonment.
 *
 * Every decision reloads and locks PostgreSQL evidence. Process-local executor
 * phase and provider-intent observations remain diagnostic only.
 *
 * Pure durable-evidence policy belongs to `failure.ts`. This persistence
 * boundary is responsible only for loading and locking evidence, invoking that
 * policy, and committing the selected operation-specific transaction.
 */
export class DestroyCapsuleClassificationPersistence<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly reader: CapsuleOperationReader<TDatabase, TTables>,
  ) {}

  /**
   * Classifies a live destroy execution failure from PostgreSQL-authoritative
   * evidence.
   *
   * An already-terminal operation is never overwritten. A valid pre-provider
   * destroy fence is restored. Any provider intent or contradictory durable
   * evidence is classified cleanup-required.
   */
  public async classifyExecutionFailure(
    operationId: string,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<DestroyCapsuleTerminalResult | null> {
    const db = this.persistence.db
    const tables = this.persistence.tables
    return await db.transaction(async tx => {
      const operation = await lockDestroyOperation<TDatabase, TTables>(tx, tables, operationId)
      const terminality = inspectDestroyOperationTerminality(operation.status)
      if (terminality.kind === 'already_terminal') {
        return null
      }
      const capsule = await lockOwnedDestroyCapsule<TDatabase, TTables>(
        tx,
        tables,
        operation.ownerId,
        operation.capsuleId,
      )
      const branches = await lockDestroyCapsuleBranches<TDatabase, TTables>(tx, tables, operation.capsuleId)
      const lineage = inspectDestroyCapsuleBranchLineage(operation.ownerId, operation.capsuleId, branches, 'destroying')
      const decision = decideDestroyNonterminalFailure({
        operation: {
          operationStatus: terminality.operationStatus,
          providerMutationStartedAt: operation.providerMutationStartedAt,
        },
        capsule: {
          lifecycleStatus: capsule.lifecycleStatus,
          archivedAt: capsule.archivedAt,
        },
        lineage,
      })
      const durableContext: Record<string, unknown> = {
        ...context,
        classification: 'destroy_execution_failure',
        failurePolicyDecision: decision.kind,
        previousOperationStatus: operation.status,
        providerIntentPresent: operation.providerMutationStartedAt !== null,
        providerMutationStartedAt: operation.providerMutationStartedAt?.toISOString() ?? null,
        capsuleLifecycleStatus: capsule.lifecycleStatus,
        capsuleArchived: capsule.archivedAt !== null,
        destroyingBranchLineage: lineage,
      }
      if (decision.kind === 'safe_pre_provider_failure') {
        return await this.failBeforeProviderMutationInTransaction(tx, operation, capsule, branches, error, {
          ...durableContext,
          safePreProviderFailure: true,
        })
      }
      return await this.markCleanupRequiredInTransaction(tx, operation, capsule, error, {
        ...durableContext,
        safePreProviderFailure: false,
        failurePolicyReasons: decision.reasons,
        invariantViolation: decision.invariantViolation,
        providerOwnershipUncertain: decision.providerOwnershipUncertain,
      })
    })
  }

  /**
   * Classifies a destroy operation left nonterminal by a previous Worker.
   *
   * No executor is invoked and no provider state is inspected. Classification
   * delegates to the same PostgreSQL-authoritative durable-evidence path used
   * for live execution failures.
   */
  public async classifyAbandoned(operationId: string): Promise<DestroyCapsuleAbandonedClassificationResult> {
    const operation = await this.reader.loadById(operationId)
    if (!operation || operation.type !== CapsuleOperationType.DESTROY) {
      return null
    }
    const terminality = inspectDestroyOperationTerminality(operation.status)
    if (terminality.kind === 'already_terminal') {
      return null
    }
    const abandonedError = new IncusError(
      'Capsule destroy operation was abandoned by a previous Worker process.',
      'API_ERROR',
      {
        operationId,
        capsuleId: operation.capsuleId,
        providerMutationStartedAt: operation.providerMutationStartedAt,
        policy: 'no_provider_mutation_after_restart',
      },
    )
    return await this.classifyExecutionFailure(operationId, abandonedError, {
      operationId,
      capsuleId: operation.capsuleId,
      phase: 'startup_abandoned_operation_classification',
      action: 'classify_abandoned_destroy_operation',
      policy: 'no_executor_replay_after_worker_restart',
    })
  }

  /**
   * Restores an intact destroy mutation fence after PostgreSQL proves that no
   * provider-intent fence was committed.
   */
  private async failBeforeProviderMutationInTransaction(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    operation: PersistedDestroyOperation,
    capsule: PersistedDestroyCapsule,
    branches: readonly DestroyCapsuleAcceptedBranch[],
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<DestroyCapsuleTerminalResult> {
    const { capsuleOperations, capsules, capsuleBranches } = this.persistence.tables
    const lineage = inspectDestroyCapsuleBranchLineage(operation.ownerId, operation.capsuleId, branches, 'destroying')
    if (
      !isDestroyNonterminalOperationStatus(operation.status) ||
      operation.providerMutationStartedAt !== null ||
      capsule.lifecycleStatus !== 'destroying' ||
      capsule.archivedAt === null ||
      !lineage.valid
    ) {
      throw new IncusError('Capsule destroy durable evidence does not prove a safe pre-provider failure.', 'CONFLICT', {
        operationId: operation.id,
        operationStatus: operation.status,
        providerMutationStartedAt: operation.providerMutationStartedAt?.toISOString() ?? null,
        capsuleLifecycleStatus: capsule.lifecycleStatus,
        capsuleArchived: capsule.archivedAt !== null,
        destroyingBranchLineage: lineage,
      })
    }
    const failureDetails = createOperationFailureDetails(error, context)
    const originalArchivedAt = capsule.archivedAt
    const now = new Date()
    const [failedOperation] = await tx
      .update(capsuleOperations)
      .set({
        status: CapsuleOperationStatus.FAILED,
        failedAt: now,
        failureCode: operationFailureCodeFromUnknown(error),
        failureMessage: operationFailureMessageFromUnknown(error, 'Capsule destroy failed before provider mutation.'),
        failureDetails:
          failureDetails === undefined
            ? undefined
            : toJsonObject(failureDetails, 'capsule destroy pre-provider failure details'),
        updatedAt: now,
      })
      .where(
        and(
          eq(capsuleOperations.id, operation.id),
          eq(capsuleOperations.type, CapsuleOperationType.DESTROY),
          inArray(capsuleOperations.status, NONTERMINAL_DESTROY_STATUSES),
          isNull(capsuleOperations.providerMutationStartedAt),
        ),
      )
      .returning({
        id: capsuleOperations.id,
      })
    const [restoredCapsule] = await tx
      .update(capsules)
      .set({
        lifecycleStatus: 'active',
        updatedAt: now,
      })
      .where(
        and(
          eq(capsules.id, operation.capsuleId),
          eq(capsules.ownerId, operation.ownerId),
          eq(capsules.lifecycleStatus, 'destroying'),
          isNotNull(capsules.archivedAt),
        ),
      )
      .returning({
        lifecycleStatus: capsules.lifecycleStatus,
        archivedAt: capsules.archivedAt,
        destroyedAt: capsules.destroyedAt,
      })
    const restoredBranches = await tx
      .update(capsuleBranches)
      .set({
        status: 'offline',
        runtimeIp: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(capsuleBranches.capsuleId, operation.capsuleId),
          eq(capsuleBranches.ownerId, operation.ownerId),
          eq(capsuleBranches.status, 'destroying'),
        ),
      )
      .returning({
        id: capsuleBranches.id,
        capsuleId: capsuleBranches.capsuleId,
        name: capsuleBranches.name,
        status: capsuleBranches.status,
      })
    if (
      !failedOperation ||
      !restoredCapsule ||
      restoredCapsule.archivedAt === null ||
      restoredCapsule.archivedAt.getTime() !== originalArchivedAt.getTime() ||
      restoredBranches.length !== branches.length
    ) {
      throw new IncusError(
        'Failed to atomically restore capsule state after pre-provider destroy failure.',
        'CONFLICT',
        {
          operationId: operation.id,
          capsuleId: operation.capsuleId,
          expectedBranchCount: branches.length,
          restoredBranchCount: restoredBranches.length,
          originalArchivedAt: originalArchivedAt.toISOString(),
          restoredArchivedAt: restoredCapsule?.archivedAt?.toISOString() ?? null,
        },
      )
    }
    return {
      operation: toCapsuleOperationTransition({
        ownerId: operation.ownerId,
        operationId: operation.id,
        operationType: CapsuleOperationType.DESTROY,
        operationStatus: CapsuleOperationStatus.FAILED,
        capsuleId: operation.capsuleId,
      }),
      capsule: toCapsuleLifecycleState({
        capsuleId: operation.capsuleId,
        lifecycleStatus: restoredCapsule.lifecycleStatus,
        archivedAt: restoredCapsule.archivedAt,
        destroyedAt: restoredCapsule.destroyedAt,
      }),
      branches: restoredBranches,
    }
  }

  /**
   * Marks a nonterminal destroy operation and its affected aggregate
   * cleanup-required after provider intent or contradictory durable evidence.
   */
  private async markCleanupRequiredInTransaction(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    operation: PersistedDestroyOperation,
    capsule: PersistedDestroyCapsule,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<DestroyCapsuleTerminalResult> {
    if (!isDestroyNonterminalOperationStatus(operation.status)) {
      throw new IncusError('Capsule destroy operation is already terminal.', 'CONFLICT', {
        operationId: operation.id,
        operationStatus: operation.status,
      })
    }
    const { capsuleOperations, capsules, capsuleBranches } = this.persistence.tables
    const failureDetails = createOperationFailureDetails(error, context)
    const now = new Date()
    const [cleanupOperation] = await tx
      .update(capsuleOperations)
      .set({
        status: CapsuleOperationStatus.CLEANUP_REQUIRED,
        failedAt: now,
        failureCode: operationFailureCodeFromUnknown(error),
        failureMessage: operationFailureMessageFromUnknown(
          error,
          'Capsule destroy requires manual cleanup and inspection.',
        ),
        failureDetails:
          failureDetails === undefined
            ? undefined
            : toJsonObject(failureDetails, 'capsule destroy cleanup-required details'),
        updatedAt: now,
      })
      .where(
        and(
          eq(capsuleOperations.id, operation.id),
          eq(capsuleOperations.type, CapsuleOperationType.DESTROY),
          inArray(capsuleOperations.status, NONTERMINAL_DESTROY_STATUSES),
        ),
      )
      .returning({
        id: capsuleOperations.id,
      })
    if (!cleanupOperation) {
      throw new IncusError('Failed to mark capsule destroy operation cleanup-required.', 'CONFLICT', {
        operationId: operation.id,
        capsuleId: operation.capsuleId,
      })
    }
    let committedCapsule = {
      lifecycleStatus: capsule.lifecycleStatus,
      archivedAt: capsule.archivedAt,
      destroyedAt: capsule.destroyedAt,
    }
    if (capsule.lifecycleStatus !== 'destroyed') {
      const [cleanupCapsule] = await tx
        .update(capsules)
        .set({
          lifecycleStatus: 'cleanup_required',
          updatedAt: now,
        })
        .where(
          and(
            eq(capsules.id, operation.capsuleId),
            eq(capsules.ownerId, operation.ownerId),
            ne(capsules.lifecycleStatus, 'destroyed'),
          ),
        )
        .returning({
          lifecycleStatus: capsules.lifecycleStatus,
          archivedAt: capsules.archivedAt,
          destroyedAt: capsules.destroyedAt,
        })
      if (!cleanupCapsule) {
        throw new IncusError(
          'Failed to mark capsule aggregate cleanup-required after destroy uncertainty.',
          'CONFLICT',
          {
            operationId: operation.id,
            capsuleId: operation.capsuleId,
          },
        )
      }
      committedCapsule = cleanupCapsule
    }
    await tx
      .update(capsuleBranches)
      .set({
        status: 'cleanup_required',
        runtimeIp: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(capsuleBranches.capsuleId, operation.capsuleId),
          eq(capsuleBranches.ownerId, operation.ownerId),
          ne(capsuleBranches.status, 'destroyed'),
        ),
      )
    const committedBranches = await tx
      .select({
        id: capsuleBranches.id,
        capsuleId: capsuleBranches.capsuleId,
        name: capsuleBranches.name,
        status: capsuleBranches.status,
      })
      .from(capsuleBranches)
      .where(and(eq(capsuleBranches.capsuleId, operation.capsuleId), eq(capsuleBranches.ownerId, operation.ownerId)))
      .orderBy(asc(capsuleBranches.id))
    return {
      operation: toCapsuleOperationTransition({
        ownerId: operation.ownerId,
        operationId: operation.id,
        operationType: CapsuleOperationType.DESTROY,
        operationStatus: CapsuleOperationStatus.CLEANUP_REQUIRED,
        capsuleId: operation.capsuleId,
      }),
      capsule: toCapsuleLifecycleState({
        capsuleId: operation.capsuleId,
        lifecycleStatus: committedCapsule.lifecycleStatus,
        archivedAt: committedCapsule.archivedAt,
        destroyedAt: committedCapsule.destroyedAt,
      }),
      branches: committedBranches,
    }
  }
}
