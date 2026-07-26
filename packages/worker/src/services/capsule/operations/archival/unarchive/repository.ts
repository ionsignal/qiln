import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  CapsuleUnarchiveReceiptSchema,
  type CapsuleOperationRequestHash,
  type CapsuleOperationStatusValue,
  type CapsuleUnarchiveReceipt,
  type QilnPersistence,
  type QilnTables,
} from '@qiln/core/server'
import { IncusError, isUniqueConstraintViolation } from '../../../../../errors'
import {
  createFailureDetails as createOperationFailureDetails,
  failureCodeFromUnknown as operationFailureCodeFromUnknown,
  failureMessageFromUnknown as operationFailureMessageFromUnknown,
} from '../../../failures'
import {
  assertValidOfflineBranchLineage,
  inspectOfflineBranchLineage,
  lockArchivalCapsuleBranches,
  lockOwnedArchivalCapsule,
  readOwnedArchivalCapsule,
  type ArchivalCapsuleRecord,
  type ProviderFreeArchivalOperationLedger,
} from '../shared'
import {
  toCapsuleLifecycleState,
  toCapsuleOperationTransition,
  type CapsuleOperationTransitionOutput,
  type PersistedCapsuleOperation,
} from '../../shared'
import { toJsonObject } from '../../../persistence/json'
import type {
  AcceptUnarchiveCapsuleOperationInput,
  UnarchiveCapsuleAbandonedClassificationResult,
  UnarchiveCapsuleAcceptanceResult,
  UnarchiveCapsuleExecutionInput,
  UnarchiveCapsuleTerminalResult,
} from './types'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

const NONTERMINAL_UNARCHIVE_STATUSES = [CapsuleOperationStatus.ACCEPTED, CapsuleOperationStatus.RUNNING] as const

type PersistedUnarchiveOperation = QilnTables['capsuleOperations']['$inferSelect']

function isNonterminalUnarchiveStatus(
  status: CapsuleOperationStatusValue,
): status is (typeof NONTERMINAL_UNARCHIVE_STATUSES)[number] {
  return status === CapsuleOperationStatus.ACCEPTED || status === CapsuleOperationStatus.RUNNING
}

function isSameTimestamp(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime()
}

/**
 * Owns unarchive-specific durable acceptance, execution fencing, timestamp
 * preservation, terminal aggregate transitions, and abandoned-operation
 * classification.
 *
 * Provider-free operation-ledger mechanics and capsule-lineage queries are
 * shared with archive. Unarchive eligibility, archive-timestamp policy, and
 * terminal classification remain explicit in this repository.
 */
export class CapsuleUnarchiveRepository<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends QilnTables = QilnTables,
> {
  constructor(
    private readonly persistence: QilnPersistence<TDatabase, TTables>,
    private readonly operationLedger: ProviderFreeArchivalOperationLedger<TDatabase, TTables>,
  ) {}

  // ---------------------------------------------------------------------------
  // Acceptance and replay
  // ---------------------------------------------------------------------------

  /**
   * Durably accepts or replays one unarchive operation.
   *
   * The first replay lookup handles ordinary idempotent submissions. The lookup
   * after a uniqueness violation closes the concurrent acceptance race.
   */
  public async acceptOrReplay(input: AcceptUnarchiveCapsuleOperationInput): Promise<UnarchiveCapsuleAcceptanceResult> {
    const replay = await this.findSubmissionReplay(input.ownerId, input.actor, input.idempotencyKey, input.requestHash)

    if (replay) {
      return replay
    }

    try {
      return await this.persistence.db.transaction(async tx => {
        const capsule = await lockOwnedArchivalCapsule<TDatabase, TTables>(
          tx,
          this.persistence.tables,
          input.ownerId,
          input.capsuleId,
        )

        if (capsule.lifecycleStatus !== 'active' || capsule.archivedAt === null) {
          throw new IncusError('Only an active, archived capsule can be unarchived.', 'CONFLICT', {
            ownerId: input.ownerId,
            capsuleId: input.capsuleId,
            lifecycleStatus: capsule.lifecycleStatus,
            archived: capsule.archivedAt !== null,
          })
        }

        const branches = await lockArchivalCapsuleBranches<TDatabase, TTables>(
          tx,
          this.persistence.tables,
          input.capsuleId,
        )

        assertValidOfflineBranchLineage(input.ownerId, input.capsuleId, branches)

        const originalArchivedAt = capsule.archivedAt
        const now = new Date()

        const [operation] = await tx
          .insert(this.persistence.tables.capsuleOperations)
          .values({
            ownerId: input.ownerId,
            actorType: input.actor.type,
            actorId: input.actor.id,
            capsuleId: input.capsuleId,
            type: CapsuleOperationType.UNARCHIVE,
            status: CapsuleOperationStatus.ACCEPTED,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            acceptedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning({
            id: this.persistence.tables.capsuleOperations.id,
            ownerId: this.persistence.tables.capsuleOperations.ownerId,
            capsuleId: this.persistence.tables.capsuleOperations.capsuleId,
            status: this.persistence.tables.capsuleOperations.status,
          })

        if (!operation) {
          throw new IncusError('Failed to durably accept the capsule unarchive operation.', 'API_ERROR')
        }

        const [unarchivingCapsule] = await tx
          .update(this.persistence.tables.capsules)
          .set({
            lifecycleStatus: 'unarchiving',
            updatedAt: now,
          })
          .where(
            and(
              eq(this.persistence.tables.capsules.id, input.capsuleId),
              eq(this.persistence.tables.capsules.ownerId, input.ownerId),
              eq(this.persistence.tables.capsules.lifecycleStatus, 'active'),
              isNotNull(this.persistence.tables.capsules.archivedAt),
            ),
          )
          .returning({
            lifecycleStatus: this.persistence.tables.capsules.lifecycleStatus,
            archivedAt: this.persistence.tables.capsules.archivedAt,
            destroyedAt: this.persistence.tables.capsules.destroyedAt,
          })

        if (
          !unarchivingCapsule ||
          unarchivingCapsule.archivedAt === null ||
          !isSameTimestamp(originalArchivedAt, unarchivingCapsule.archivedAt)
        ) {
          throw new IncusError(
            'Failed to enter the capsule unarchive mutation fence while preserving its archive timestamp.',
            'CONFLICT',
            {
              ownerId: input.ownerId,
              capsuleId: input.capsuleId,
              originalArchivedAt: originalArchivedAt.toISOString(),
              committedArchivedAt: unarchivingCapsule?.archivedAt?.toISOString() ?? null,
            },
          )
        }

        return {
          newlyAccepted: true,
          receipt: this.createReceipt({
            operationId: operation.id,
            capsuleId: operation.capsuleId,
            operationStatus: operation.status,
            replayed: false,
          }),
          operation: this.toOperationTransition({
            ownerId: operation.ownerId,
            operationId: operation.id,
            capsuleId: operation.capsuleId,
            operationStatus: operation.status,
          }),
          capsule: toCapsuleLifecycleState({
            capsuleId: operation.capsuleId,
            lifecycleStatus: unarchivingCapsule.lifecycleStatus,
            archivedAt: unarchivingCapsule.archivedAt,
            destroyedAt: unarchivingCapsule.destroyedAt,
          }),
        }
      })
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) {
        throw error
      }

      const racedReplay = await this.findSubmissionReplay(
        input.ownerId,
        input.actor,
        input.idempotencyKey,
        input.requestHash,
      )

      if (racedReplay) {
        return racedReplay
      }

      throw new IncusError('Capsule unarchive conflicts with another durable capsule operation.', 'CONFLICT', {
        ownerId: input.ownerId,
        capsuleId: input.capsuleId,
      })
    }
  }

  private async findSubmissionReplay(
    ownerId: string,
    actor: AcceptUnarchiveCapsuleOperationInput['actor'],
    idempotencyKey: string,
    requestHash: CapsuleOperationRequestHash,
  ): Promise<UnarchiveCapsuleAcceptanceResult | null> {
    const operation = await this.operationLedger.findSubmissionReplay({
      ownerId,
      actor,
      idempotencyKey,
      requestHash,
      operationType: CapsuleOperationType.UNARCHIVE,
      requestDescription: 'capsule unarchive',
    })

    if (!operation) {
      return null
    }

    return await this.loadAcceptanceResult(operation, false, true)
  }

  // ---------------------------------------------------------------------------
  // Execution input and claiming
  // ---------------------------------------------------------------------------

  /**
   * Reloads unarchive execution identity entirely from PostgreSQL.
   *
   * The executor receives only the operation ID and never retains the original
   * command payload as execution input.
   */
  public async loadAcceptedExecution(operationId: string): Promise<UnarchiveCapsuleExecutionInput> {
    const operation = await this.operationLedger.loadAcceptedExecution({
      operationId,
      operationType: CapsuleOperationType.UNARCHIVE,
      operationDescription: 'capsule unarchive',
    })

    return {
      operationId: operation.id,
      ownerId: operation.ownerId,
      capsuleId: operation.capsuleId,
    }
  }

  /**
   * Claims one accepted, provider-free unarchive operation for process-local
   * execution.
   */
  public async claimAccepted(operationId: string): Promise<CapsuleOperationTransitionOutput> {
    return await this.operationLedger.claimAccepted({
      operationId,
      operationType: CapsuleOperationType.UNARCHIVE,
      operationDescription: 'capsule unarchive',
    })
  }

  // ---------------------------------------------------------------------------
  // Successful completion
  // ---------------------------------------------------------------------------

  /**
   * Atomically completes unarchive and clears the logical archive timestamp.
   *
   * This is the only normal unarchive transaction allowed to clear
   * `archivedAt`.
   */
  public async complete(operationId: string): Promise<UnarchiveCapsuleTerminalResult> {
    return await this.persistence.db.transaction(async tx => {
      const operation = await this.lockUnarchiveOperation(tx, operationId)

      if (operation.status !== CapsuleOperationStatus.RUNNING || operation.providerMutationStartedAt !== null) {
        throw new IncusError('Capsule unarchive operation is not eligible for successful completion.', 'CONFLICT', {
          operationId,
          operationStatus: operation.status,
          hasProviderIntent: operation.providerMutationStartedAt !== null,
        })
      }

      const capsule = await lockOwnedArchivalCapsule<TDatabase, TTables>(
        tx,
        this.persistence.tables,
        operation.ownerId,
        operation.capsuleId,
      )
      const branches = await lockArchivalCapsuleBranches<TDatabase, TTables>(
        tx,
        this.persistence.tables,
        operation.capsuleId,
      )

      assertValidOfflineBranchLineage(operation.ownerId, operation.capsuleId, branches)

      if (capsule.lifecycleStatus !== 'unarchiving' || capsule.archivedAt === null) {
        throw new IncusError('Capsule is not eligible for unarchive completion.', 'CONFLICT', {
          operationId,
          capsuleId: operation.capsuleId,
          lifecycleStatus: capsule.lifecycleStatus,
          archived: capsule.archivedAt !== null,
        })
      }

      const now = new Date()

      const [completedOperation] = await tx
        .update(this.persistence.tables.capsuleOperations)
        .set({
          status: CapsuleOperationStatus.COMPLETED,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(this.persistence.tables.capsuleOperations.id, operationId),
            eq(this.persistence.tables.capsuleOperations.type, CapsuleOperationType.UNARCHIVE),
            eq(this.persistence.tables.capsuleOperations.status, CapsuleOperationStatus.RUNNING),
            isNull(this.persistence.tables.capsuleOperations.providerMutationStartedAt),
          ),
        )
        .returning({
          id: this.persistence.tables.capsuleOperations.id,
        })

      const [unarchivedCapsule] = await tx
        .update(this.persistence.tables.capsules)
        .set({
          lifecycleStatus: 'active',
          archivedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(this.persistence.tables.capsules.id, operation.capsuleId),
            eq(this.persistence.tables.capsules.ownerId, operation.ownerId),
            eq(this.persistence.tables.capsules.lifecycleStatus, 'unarchiving'),
            isNotNull(this.persistence.tables.capsules.archivedAt),
          ),
        )
        .returning({
          lifecycleStatus: this.persistence.tables.capsules.lifecycleStatus,
          archivedAt: this.persistence.tables.capsules.archivedAt,
          destroyedAt: this.persistence.tables.capsules.destroyedAt,
        })

      if (!completedOperation || !unarchivedCapsule || unarchivedCapsule.archivedAt !== null) {
        throw new IncusError('Failed to atomically complete capsule unarchive.', 'CONFLICT', {
          operationId,
          capsuleId: operation.capsuleId,
        })
      }

      return {
        operation: this.toOperationTransition({
          ownerId: operation.ownerId,
          operationId,
          capsuleId: operation.capsuleId,
          operationStatus: CapsuleOperationStatus.COMPLETED,
        }),
        capsule: toCapsuleLifecycleState({
          capsuleId: operation.capsuleId,
          lifecycleStatus: unarchivedCapsule.lifecycleStatus,
          archivedAt: unarchivedCapsule.archivedAt,
          destroyedAt: unarchivedCapsule.destroyedAt,
        }),
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Execution failure
  // ---------------------------------------------------------------------------

  /**
   * Classifies a provider-free unarchive execution failure from any nonterminal
   * phase, including execution-input loading and accepted-to-running claiming.
   *
   * The transaction reloads and locks all durable evidence. It does not trust
   * the executor's process-local phase to decide whether aggregate restoration
   * is safe.
   *
   * An intact provider-free unarchive fence becomes an ordinary failed
   * operation and restores the active, archived capsule state while preserving
   * its exact archive timestamp. Contradictory durable evidence is classified
   * cleanup-required.
   *
   * A null result means the operation became terminal before this
   * classification transaction acquired its lock. Existing terminal state is
   * authoritative and is never overwritten.
   */
  public async classifyExecutionFailure(
    operationId: string,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<UnarchiveCapsuleTerminalResult | null> {
    return await this.persistence.db.transaction(async tx => {
      const operation = await this.lockUnarchiveOperation(tx, operationId)

      if (!isNonterminalUnarchiveStatus(operation.status)) {
        return null
      }

      const capsule = await lockOwnedArchivalCapsule<TDatabase, TTables>(
        tx,
        this.persistence.tables,
        operation.ownerId,
        operation.capsuleId,
      )
      const branches = await lockArchivalCapsuleBranches<TDatabase, TTables>(
        tx,
        this.persistence.tables,
        operation.capsuleId,
      )
      const lineage = inspectOfflineBranchLineage(operation.ownerId, operation.capsuleId, branches)
      const originalArchivedAt = capsule.archivedAt

      const safeProviderFreeFailure =
        operation.providerMutationStartedAt === null &&
        capsule.lifecycleStatus === 'unarchiving' &&
        originalArchivedAt !== null &&
        lineage.valid

      if (!safeProviderFreeFailure) {
        return await this.markCleanupRequiredInTransaction(tx, operation, capsule, error, {
          ...context,
          classification: 'unarchive_execution_failure',
          invariantViolation: true,
          previousOperationStatus: operation.status,
          providerIntentPresent: operation.providerMutationStartedAt !== null,
          capsuleLifecycleStatus: capsule.lifecycleStatus,
          capsuleArchived: originalArchivedAt !== null,
          offlineBranchLineage: lineage,
        })
      }

      return await this.markSafeFailureInTransaction(
        tx,
        operation,
        originalArchivedAt,
        error,
        {
          ...context,
          classification: 'unarchive_execution_failure',
          previousOperationStatus: operation.status,
          providerIntentPresent: false,
          offlineBranchLineage: lineage,
        },
        'Capsule unarchive failed.',
      )
    })
  }

  // ---------------------------------------------------------------------------
  // Abandoned-operation classification
  // ---------------------------------------------------------------------------

  /**
   * Classifies an unarchive operation left nonterminal by a previous Worker.
   *
   * No executor is invoked and no provider state is inspected. A valid
   * provider-free unarchive fence is restored to active while preserving its
   * exact archive timestamp. Contradictory durable evidence is classified
   * cleanup-required.
   */
  public async classifyAbandoned(operationId: string): Promise<UnarchiveCapsuleAbandonedClassificationResult> {
    return await this.persistence.db.transaction(async tx => {
      const operation = await this.lockUnarchiveOperationIfPresent(tx, operationId)

      if (!operation) {
        return null
      }

      if (operation.type !== CapsuleOperationType.UNARCHIVE) {
        throw new IncusError('Abandoned-operation classification received a non-unarchive operation.', 'CONFLICT', {
          operationId,
          operationType: operation.type,
        })
      }

      if (!isNonterminalUnarchiveStatus(operation.status)) {
        return null
      }

      const capsule = await lockOwnedArchivalCapsule<TDatabase, TTables>(
        tx,
        this.persistence.tables,
        operation.ownerId,
        operation.capsuleId,
      )
      const branches = await lockArchivalCapsuleBranches<TDatabase, TTables>(
        tx,
        this.persistence.tables,
        operation.capsuleId,
      )
      const lineage = inspectOfflineBranchLineage(operation.ownerId, operation.capsuleId, branches)
      const originalArchivedAt = capsule.archivedAt

      if (
        operation.providerMutationStartedAt !== null ||
        capsule.lifecycleStatus !== 'unarchiving' ||
        originalArchivedAt === null ||
        !lineage.valid
      ) {
        const invariantError = {
          code: 'CAPSULE_UNARCHIVE_INVARIANT_VIOLATION',
          message: 'Abandoned capsule unarchive operation violated its provider-free unarchive invariant.',
        }

        return await this.markCleanupRequiredInTransaction(tx, operation, capsule, invariantError, {
          operationId,
          capsuleId: operation.capsuleId,
          phase: 'startup_abandoned_operation_classification',
          classification: 'abandoned_unarchive_operation',
          invariantViolation: true,
          providerIntentPresent: operation.providerMutationStartedAt !== null,
          capsuleLifecycleStatus: capsule.lifecycleStatus,
          capsuleArchived: originalArchivedAt !== null,
          offlineBranchLineage: lineage,
        })
      }

      const abandonedError = {
        code: 'ABANDONED_CAPSULE_UNARCHIVE_OPERATION',
        message: 'Capsule unarchive operation was abandoned before completion.',
      }

      return await this.markSafeFailureInTransaction(
        tx,
        operation,
        originalArchivedAt,
        abandonedError,
        {
          operationId,
          capsuleId: operation.capsuleId,
          phase: 'startup_abandoned_operation_classification',
          classification: 'abandoned_unarchive_operation',
          previousOperationStatus: operation.status,
          providerIntentPresent: false,
          policy: 'provider_free_unarchive_restore',
          offlineBranchLineage: lineage,
        },
        'Capsule unarchive operation was abandoned.',
      )
    })
  }

  // ---------------------------------------------------------------------------
  // Terminalization mechanics
  // ---------------------------------------------------------------------------

  private async markSafeFailureInTransaction(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    operation: PersistedUnarchiveOperation,
    originalArchivedAt: Date,
    error: unknown,
    context: Record<string, unknown>,
    fallbackMessage: string,
  ): Promise<UnarchiveCapsuleTerminalResult> {
    if (!isNonterminalUnarchiveStatus(operation.status)) {
      throw new IncusError('Capsule unarchive operation is already terminal.', 'CONFLICT', {
        operationId: operation.id,
        operationStatus: operation.status,
      })
    }

    if (operation.providerMutationStartedAt !== null) {
      throw new IncusError(
        'Provider-free capsule unarchive failure contains contradictory provider-intent evidence.',
        'CONFLICT',
        {
          operationId: operation.id,
          providerMutationStartedAt: operation.providerMutationStartedAt?.toISOString() ?? null,
        },
      )
    }

    const failureDetails = createOperationFailureDetails(error, context)
    const now = new Date()

    const [failedOperation] = await tx
      .update(this.persistence.tables.capsuleOperations)
      .set({
        status: CapsuleOperationStatus.FAILED,
        failedAt: now,
        failureCode: operationFailureCodeFromUnknown(error),
        failureMessage: operationFailureMessageFromUnknown(error, fallbackMessage),
        failureDetails:
          failureDetails === undefined ? undefined : toJsonObject(failureDetails, 'capsule unarchive failure details'),
        updatedAt: now,
      })
      .where(
        and(
          eq(this.persistence.tables.capsuleOperations.id, operation.id),
          eq(this.persistence.tables.capsuleOperations.type, CapsuleOperationType.UNARCHIVE),
          inArray(this.persistence.tables.capsuleOperations.status, NONTERMINAL_UNARCHIVE_STATUSES),
          isNull(this.persistence.tables.capsuleOperations.providerMutationStartedAt),
        ),
      )
      .returning({
        id: this.persistence.tables.capsuleOperations.id,
      })

    const [restoredCapsule] = await tx
      .update(this.persistence.tables.capsules)
      .set({
        lifecycleStatus: 'active',
        updatedAt: now,
      })
      .where(
        and(
          eq(this.persistence.tables.capsules.id, operation.capsuleId),
          eq(this.persistence.tables.capsules.ownerId, operation.ownerId),
          eq(this.persistence.tables.capsules.lifecycleStatus, 'unarchiving'),
          isNotNull(this.persistence.tables.capsules.archivedAt),
        ),
      )
      .returning({
        lifecycleStatus: this.persistence.tables.capsules.lifecycleStatus,
        archivedAt: this.persistence.tables.capsules.archivedAt,
        destroyedAt: this.persistence.tables.capsules.destroyedAt,
      })

    if (
      !failedOperation ||
      !restoredCapsule ||
      restoredCapsule.archivedAt === null ||
      !isSameTimestamp(originalArchivedAt, restoredCapsule.archivedAt)
    ) {
      throw new IncusError('Failed to atomically restore capsule state after unarchive failure.', 'CONFLICT', {
        operationId: operation.id,
        capsuleId: operation.capsuleId,
        originalArchivedAt: originalArchivedAt.toISOString(),
        restoredArchivedAt: restoredCapsule?.archivedAt?.toISOString() ?? null,
      })
    }

    return {
      operation: this.toOperationTransition({
        ownerId: operation.ownerId,
        operationId: operation.id,
        capsuleId: operation.capsuleId,
        operationStatus: CapsuleOperationStatus.FAILED,
      }),
      capsule: toCapsuleLifecycleState({
        capsuleId: operation.capsuleId,
        lifecycleStatus: restoredCapsule.lifecycleStatus,
        archivedAt: restoredCapsule.archivedAt,
        destroyedAt: restoredCapsule.destroyedAt,
      }),
    }
  }

  private async markCleanupRequiredInTransaction(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    operation: PersistedUnarchiveOperation,
    capsule: ArchivalCapsuleRecord,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<UnarchiveCapsuleTerminalResult> {
    if (!isNonterminalUnarchiveStatus(operation.status)) {
      throw new IncusError('Capsule unarchive operation is already terminal.', 'CONFLICT', {
        operationId: operation.id,
        operationStatus: operation.status,
      })
    }

    const failureDetails = createOperationFailureDetails(error, context)
    const now = new Date()

    const [cleanupOperation] = await tx
      .update(this.persistence.tables.capsuleOperations)
      .set({
        status: CapsuleOperationStatus.CLEANUP_REQUIRED,
        failedAt: now,
        failureCode: operationFailureCodeFromUnknown(error),
        failureMessage: operationFailureMessageFromUnknown(
          error,
          'Capsule unarchive requires manual cleanup and inspection.',
        ),
        failureDetails:
          failureDetails === undefined
            ? undefined
            : toJsonObject(failureDetails, 'capsule unarchive cleanup-required details'),
        updatedAt: now,
      })
      .where(
        and(
          eq(this.persistence.tables.capsuleOperations.id, operation.id),
          eq(this.persistence.tables.capsuleOperations.type, CapsuleOperationType.UNARCHIVE),
          inArray(this.persistence.tables.capsuleOperations.status, NONTERMINAL_UNARCHIVE_STATUSES),
        ),
      )
      .returning({
        id: this.persistence.tables.capsuleOperations.id,
      })

    if (!cleanupOperation) {
      throw new IncusError('Failed to mark the capsule unarchive operation cleanup-required.', 'CONFLICT', {
        operationId: operation.id,
        capsuleId: operation.capsuleId,
      })
    }

    let committedCapsule = {
      lifecycleStatus: capsule.lifecycleStatus,
      archivedAt: capsule.archivedAt,
      destroyedAt: capsule.destroyedAt,
    }

    // A terminal destroyed capsule cannot be rewritten without violating its
    // durable destroyed-timestamp invariant.
    if (capsule.lifecycleStatus !== 'destroyed') {
      const [cleanupCapsule] = await tx
        .update(this.persistence.tables.capsules)
        .set({
          lifecycleStatus: 'cleanup_required',
          updatedAt: now,
        })
        .where(
          and(
            eq(this.persistence.tables.capsules.id, operation.capsuleId),
            eq(this.persistence.tables.capsules.ownerId, operation.ownerId),
          ),
        )
        .returning({
          lifecycleStatus: this.persistence.tables.capsules.lifecycleStatus,
          archivedAt: this.persistence.tables.capsules.archivedAt,
          destroyedAt: this.persistence.tables.capsules.destroyedAt,
        })

      if (!cleanupCapsule) {
        throw new IncusError(
          'Failed to mark the capsule cleanup-required after an unarchive invariant violation.',
          'CONFLICT',
          {
            operationId: operation.id,
            capsuleId: operation.capsuleId,
          },
        )
      }

      committedCapsule = cleanupCapsule
    }

    return {
      operation: this.toOperationTransition({
        ownerId: operation.ownerId,
        operationId: operation.id,
        capsuleId: operation.capsuleId,
        operationStatus: CapsuleOperationStatus.CLEANUP_REQUIRED,
      }),
      capsule: toCapsuleLifecycleState({
        capsuleId: operation.capsuleId,
        lifecycleStatus: committedCapsule.lifecycleStatus,
        archivedAt: committedCapsule.archivedAt,
        destroyedAt: committedCapsule.destroyedAt,
      }),
    }
  }

  // ---------------------------------------------------------------------------
  // Result mapping
  // ---------------------------------------------------------------------------

  private async loadAcceptanceResult(
    operation: PersistedCapsuleOperation,
    newlyAccepted: boolean,
    replayed: boolean,
  ): Promise<UnarchiveCapsuleAcceptanceResult> {
    const capsule = await readOwnedArchivalCapsule(this.persistence, operation.ownerId, operation.capsuleId)

    if (!capsule) {
      throw new IncusError('Capsule unarchive operation references a missing capsule aggregate.', 'API_ERROR', {
        operationId: operation.id,
        capsuleId: operation.capsuleId,
      })
    }

    return {
      newlyAccepted,
      receipt: this.createReceipt({
        operationId: operation.id,
        capsuleId: operation.capsuleId,
        operationStatus: operation.status,
        replayed,
      }),
      operation: this.toOperationTransition({
        ownerId: operation.ownerId,
        operationId: operation.id,
        capsuleId: operation.capsuleId,
        operationStatus: operation.status,
      }),
      capsule: toCapsuleLifecycleState({
        capsuleId: operation.capsuleId,
        lifecycleStatus: capsule.lifecycleStatus,
        archivedAt: capsule.archivedAt,
        destroyedAt: capsule.destroyedAt,
      }),
    }
  }

  private createReceipt(input: {
    operationId: string
    capsuleId: string
    operationStatus: CapsuleOperationStatusValue
    replayed: boolean
  }): CapsuleUnarchiveReceipt {
    return CapsuleUnarchiveReceiptSchema.parse({
      operationId: input.operationId,
      operationType: CapsuleOperationType.UNARCHIVE,
      operationStatus: input.operationStatus,
      capsuleId: input.capsuleId,
      replayed: input.replayed,
    })
  }

  private toOperationTransition(input: {
    ownerId: string
    operationId: string
    capsuleId: string
    operationStatus: CapsuleOperationStatusValue
  }): CapsuleOperationTransitionOutput {
    return toCapsuleOperationTransition({
      ownerId: input.ownerId,
      operationId: input.operationId,
      operationType: CapsuleOperationType.UNARCHIVE,
      operationStatus: input.operationStatus,
      capsuleId: input.capsuleId,
    })
  }

  // ---------------------------------------------------------------------------
  // Locking
  // ---------------------------------------------------------------------------

  private async lockUnarchiveOperation(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    operationId: string,
  ): Promise<PersistedUnarchiveOperation> {
    const operation = await this.lockUnarchiveOperationIfPresent(tx, operationId)

    if (!operation) {
      throw new IncusError('Capsule unarchive operation was not found.', 'NOT_FOUND', {
        operationId,
      })
    }

    if (operation.type !== CapsuleOperationType.UNARCHIVE) {
      throw new IncusError('Operation is not a capsule unarchive operation.', 'CONFLICT', {
        operationId,
        operationType: operation.type,
      })
    }

    return operation
  }

  private async lockUnarchiveOperationIfPresent(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    operationId: string,
  ): Promise<PersistedUnarchiveOperation | null> {
    const [operation] = await tx
      .select()
      .from(this.persistence.tables.capsuleOperations)
      .where(eq(this.persistence.tables.capsuleOperations.id, operationId))
      .for('update')
      .limit(1)

    return operation ?? null
  }
}
