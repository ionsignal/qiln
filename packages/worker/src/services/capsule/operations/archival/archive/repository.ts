import { and, eq, inArray, isNull } from 'drizzle-orm'
import {
  CapsuleArchiveReceiptSchema,
  CapsuleOperationStatus,
  CapsuleOperationType,
  type CapsuleArchiveReceipt,
  type CapsuleOperationRequestHash,
  type CapsuleOperationStatusValue,
  type CapsulePersistence,
  type CapsuleTables,
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
  AcceptArchiveCapsuleOperationInput,
  ArchiveCapsuleAbandonedClassificationResult,
  ArchiveCapsuleAcceptanceResult,
  ArchiveCapsuleExecutionInput,
  ArchiveCapsuleTerminalResult,
} from './types'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

const NONTERMINAL_ARCHIVE_STATUSES = [CapsuleOperationStatus.ACCEPTED, CapsuleOperationStatus.RUNNING] as const

type PersistedArchiveOperation = CapsuleTables['capsuleOperations']['$inferSelect']

function isNonterminalArchiveStatus(
  status: CapsuleOperationStatusValue,
): status is (typeof NONTERMINAL_ARCHIVE_STATUSES)[number] {
  return status === CapsuleOperationStatus.ACCEPTED || status === CapsuleOperationStatus.RUNNING
}

/**
 * Owns archive-specific durable acceptance, execution fencing, terminal
 * aggregate transitions, and abandoned-operation classification.
 *
 * Provider-free operation-ledger mechanics and capsule-lineage queries are
 * shared with unarchive. Archive eligibility, timestamp policy, and terminal
 * classification remain explicit in this repository.
 */
export class CapsuleArchiveRepository<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly operationLedger: ProviderFreeArchivalOperationLedger<TDatabase, TTables>,
  ) {}

  // ---------------------------------------------------------------------------
  // Acceptance and replay
  // ---------------------------------------------------------------------------

  /**
   * Durably accepts or replays one archive operation.
   *
   * The initial replay lookup avoids an unnecessary acceptance transaction. The
   * lookup after a uniqueness violation closes the concurrent acceptance race.
   * These are the two deliberate halves of the durable idempotency protocol.
   */
  public async acceptOrReplay(input: AcceptArchiveCapsuleOperationInput): Promise<ArchiveCapsuleAcceptanceResult> {
    const replay = await this.findSubmissionReplay(input.ownerId, input.actor, input.idempotencyKey, input.requestHash)

    if (replay) {
      return replay
    }

    const db = this.persistence.db
    const tables = this.persistence.tables
    const operations = tables.capsuleOperations
    const capsules = tables.capsules

    try {
      return await db.transaction(async tx => {
        const capsule = await lockOwnedArchivalCapsule<TDatabase, TTables>(tx, tables, input.ownerId, input.capsuleId)

        if (capsule.lifecycleStatus !== 'active' || capsule.archivedAt !== null) {
          throw new IncusError('Only an active, unarchived capsule can be archived.', 'CONFLICT', {
            ownerId: input.ownerId,
            capsuleId: input.capsuleId,
            lifecycleStatus: capsule.lifecycleStatus,
            archived: capsule.archivedAt !== null,
          })
        }

        const branches = await lockArchivalCapsuleBranches<TDatabase, TTables>(tx, tables, input.capsuleId)

        assertValidOfflineBranchLineage(input.ownerId, input.capsuleId, branches)

        const now = new Date()

        const [operation] = await tx
          .insert(operations)
          .values({
            ownerId: input.ownerId,
            actorType: input.actor.type,
            actorId: input.actor.id,
            capsuleId: input.capsuleId,
            type: CapsuleOperationType.ARCHIVE,
            status: CapsuleOperationStatus.ACCEPTED,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            acceptedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning({
            id: operations.id,
            ownerId: operations.ownerId,
            capsuleId: operations.capsuleId,
            status: operations.status,
          })

        if (!operation) {
          throw new IncusError('Failed to durably accept the capsule archive operation.', 'API_ERROR')
        }

        const [archivingCapsule] = await tx
          .update(capsules)
          .set({
            lifecycleStatus: 'archiving',
            updatedAt: now,
          })
          .where(
            and(
              eq(capsules.id, input.capsuleId),
              eq(capsules.ownerId, input.ownerId),
              eq(capsules.lifecycleStatus, 'active'),
              isNull(capsules.archivedAt),
            ),
          )
          .returning({
            lifecycleStatus: capsules.lifecycleStatus,
            archivedAt: capsules.archivedAt,
            destroyedAt: capsules.destroyedAt,
          })

        if (!archivingCapsule) {
          throw new IncusError('Failed to transition the capsule into its archive mutation fence.', 'CONFLICT', {
            ownerId: input.ownerId,
            capsuleId: input.capsuleId,
          })
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
            lifecycleStatus: archivingCapsule.lifecycleStatus,
            archivedAt: archivingCapsule.archivedAt,
            destroyedAt: archivingCapsule.destroyedAt,
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

      throw new IncusError('Capsule archive conflicts with another durable capsule operation.', 'CONFLICT', {
        ownerId: input.ownerId,
        capsuleId: input.capsuleId,
      })
    }
  }

  private async findSubmissionReplay(
    ownerId: string,
    actor: AcceptArchiveCapsuleOperationInput['actor'],
    idempotencyKey: string,
    requestHash: CapsuleOperationRequestHash,
  ): Promise<ArchiveCapsuleAcceptanceResult | null> {
    const operation = await this.operationLedger.findSubmissionReplay({
      ownerId,
      actor,
      idempotencyKey,
      requestHash,
      operationType: CapsuleOperationType.ARCHIVE,
      requestDescription: 'capsule archive',
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
   * Reloads archive execution identity entirely from PostgreSQL.
   *
   * The executor receives only the operation ID and never retains the original
   * command payload as execution input.
   */
  public async loadAcceptedExecution(operationId: string): Promise<ArchiveCapsuleExecutionInput> {
    const operation = await this.operationLedger.loadAcceptedExecution({
      operationId,
      operationType: CapsuleOperationType.ARCHIVE,
      operationDescription: 'capsule archive',
    })

    return {
      operationId: operation.id,
      ownerId: operation.ownerId,
      capsuleId: operation.capsuleId,
    }
  }

  /**
   * Claims one accepted, provider-free archive operation for process-local
   * execution.
   */
  public async claimAccepted(operationId: string): Promise<CapsuleOperationTransitionOutput> {
    return await this.operationLedger.claimAccepted({
      operationId,
      operationType: CapsuleOperationType.ARCHIVE,
      operationDescription: 'capsule archive',
    })
  }

  // ---------------------------------------------------------------------------
  // Successful completion
  // ---------------------------------------------------------------------------

  /**
   * Atomically completes archive and records the logical archive timestamp.
   */
  public async complete(operationId: string): Promise<ArchiveCapsuleTerminalResult> {
    const db = this.persistence.db
    const tables = this.persistence.tables
    const operations = tables.capsuleOperations
    const capsules = tables.capsules

    return await db.transaction(async tx => {
      const operation = await this.lockArchiveOperation(tx, operationId)

      if (operation.status !== CapsuleOperationStatus.RUNNING || operation.providerMutationStartedAt !== null) {
        throw new IncusError('Capsule archive operation is not eligible for successful completion.', 'CONFLICT', {
          operationId,
          operationStatus: operation.status,
          hasProviderIntent: operation.providerMutationStartedAt !== null,
        })
      }

      const capsule = await lockOwnedArchivalCapsule<TDatabase, TTables>(
        tx,
        tables,
        operation.ownerId,
        operation.capsuleId,
      )
      const branches = await lockArchivalCapsuleBranches<TDatabase, TTables>(tx, tables, operation.capsuleId)

      assertValidOfflineBranchLineage(operation.ownerId, operation.capsuleId, branches)

      if (capsule.lifecycleStatus !== 'archiving' || capsule.archivedAt !== null) {
        throw new IncusError('Capsule is not eligible for archive completion.', 'CONFLICT', {
          operationId,
          capsuleId: operation.capsuleId,
          lifecycleStatus: capsule.lifecycleStatus,
          archived: capsule.archivedAt !== null,
        })
      }

      const now = new Date()

      const [completedOperation] = await tx
        .update(operations)
        .set({
          status: CapsuleOperationStatus.COMPLETED,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(operations.id, operationId),
            eq(operations.type, CapsuleOperationType.ARCHIVE),
            eq(operations.status, CapsuleOperationStatus.RUNNING),
            isNull(operations.providerMutationStartedAt),
          ),
        )
        .returning({
          id: operations.id,
        })

      const [archivedCapsule] = await tx
        .update(capsules)
        .set({
          lifecycleStatus: 'active',
          archivedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(capsules.id, operation.capsuleId),
            eq(capsules.ownerId, operation.ownerId),
            eq(capsules.lifecycleStatus, 'archiving'),
            isNull(capsules.archivedAt),
          ),
        )
        .returning({
          lifecycleStatus: capsules.lifecycleStatus,
          archivedAt: capsules.archivedAt,
          destroyedAt: capsules.destroyedAt,
        })

      if (!completedOperation || !archivedCapsule || archivedCapsule.archivedAt === null) {
        throw new IncusError('Failed to atomically complete capsule archive.', 'CONFLICT', {
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
          lifecycleStatus: archivedCapsule.lifecycleStatus,
          archivedAt: archivedCapsule.archivedAt,
          destroyedAt: archivedCapsule.destroyedAt,
        }),
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Execution failure
  // ---------------------------------------------------------------------------

  /**
   * Classifies a provider-free archive execution failure from any nonterminal
   * phase, including execution-input loading and accepted-to-running claiming.
   *
   * The transaction reloads and locks all durable evidence. It does not trust
   * the executor's process-local phase to decide whether aggregate restoration
   * is safe.
   *
   * A valid provider-free archive fence becomes an ordinary failed operation
   * and restores the active, unarchived capsule state. Contradictory durable
   * evidence is classified cleanup-required.
   *
   * A null result means the operation became terminal before this
   * classification transaction acquired its lock. Existing terminal state is
   * authoritative and is never overwritten.
   */
  public async classifyExecutionFailure(
    operationId: string,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<ArchiveCapsuleTerminalResult | null> {
    const db = this.persistence.db
    const tables = this.persistence.tables

    return await db.transaction(async tx => {
      const operation = await this.lockArchiveOperation(tx, operationId)

      if (!isNonterminalArchiveStatus(operation.status)) {
        return null
      }

      const capsule = await lockOwnedArchivalCapsule<TDatabase, TTables>(
        tx,
        tables,
        operation.ownerId,
        operation.capsuleId,
      )
      const branches = await lockArchivalCapsuleBranches<TDatabase, TTables>(tx, tables, operation.capsuleId)
      const lineage = inspectOfflineBranchLineage(operation.ownerId, operation.capsuleId, branches)

      const safeProviderFreeFailure =
        operation.providerMutationStartedAt === null &&
        capsule.lifecycleStatus === 'archiving' &&
        capsule.archivedAt === null &&
        lineage.valid

      if (!safeProviderFreeFailure) {
        return await this.markCleanupRequiredInTransaction(tx, operation, capsule, error, {
          ...context,
          classification: 'archive_execution_failure',
          invariantViolation: true,
          previousOperationStatus: operation.status,
          providerIntentPresent: operation.providerMutationStartedAt !== null,
          capsuleLifecycleStatus: capsule.lifecycleStatus,
          capsuleArchived: capsule.archivedAt !== null,
          offlineBranchLineage: lineage,
        })
      }

      return await this.markSafeFailureInTransaction(
        tx,
        operation,
        error,
        {
          ...context,
          classification: 'archive_execution_failure',
          previousOperationStatus: operation.status,
          providerIntentPresent: false,
          offlineBranchLineage: lineage,
        },
        'Capsule archive failed.',
      )
    })
  }

  // ---------------------------------------------------------------------------
  // Abandoned-operation classification
  // ---------------------------------------------------------------------------

  /**
   * Classifies an archive operation left nonterminal by a previous Worker.
   *
   * No executor is invoked and no provider state is inspected. A valid
   * provider-free archive fence is restored to active and unarchived. Any
   * contradictory durable evidence is classified cleanup-required.
   */
  public async classifyAbandoned(operationId: string): Promise<ArchiveCapsuleAbandonedClassificationResult> {
    const db = this.persistence.db
    const tables = this.persistence.tables

    return await db.transaction(async tx => {
      const operation = await this.lockArchiveOperationIfPresent(tx, operationId)

      if (!operation) {
        return null
      }

      if (operation.type !== CapsuleOperationType.ARCHIVE) {
        throw new IncusError('Abandoned-operation classification received a non-archive operation.', 'CONFLICT', {
          operationId,
          operationType: operation.type,
        })
      }

      if (!isNonterminalArchiveStatus(operation.status)) {
        return null
      }

      const capsule = await lockOwnedArchivalCapsule<TDatabase, TTables>(
        tx,
        tables,
        operation.ownerId,
        operation.capsuleId,
      )
      const branches = await lockArchivalCapsuleBranches<TDatabase, TTables>(tx, tables, operation.capsuleId)
      const lineage = inspectOfflineBranchLineage(operation.ownerId, operation.capsuleId, branches)

      const safeProviderFreeClassification =
        operation.providerMutationStartedAt === null &&
        capsule.lifecycleStatus === 'archiving' &&
        capsule.archivedAt === null &&
        lineage.valid

      if (!safeProviderFreeClassification) {
        const invariantError = {
          code: 'CAPSULE_ARCHIVE_INVARIANT_VIOLATION',
          message: 'Abandoned capsule archive operation violated its provider-free archive invariant.',
        }

        return await this.markCleanupRequiredInTransaction(tx, operation, capsule, invariantError, {
          operationId,
          capsuleId: operation.capsuleId,
          phase: 'startup_abandoned_operation_classification',
          classification: 'abandoned_archive_operation',
          invariantViolation: true,
          providerIntentPresent: operation.providerMutationStartedAt !== null,
          capsuleLifecycleStatus: capsule.lifecycleStatus,
          capsuleArchived: capsule.archivedAt !== null,
          offlineBranchLineage: lineage,
        })
      }

      const abandonedError = {
        code: 'ABANDONED_CAPSULE_ARCHIVE_OPERATION',
        message: 'Capsule archive operation was abandoned before completion.',
      }

      return await this.markSafeFailureInTransaction(
        tx,
        operation,
        abandonedError,
        {
          operationId,
          capsuleId: operation.capsuleId,
          phase: 'startup_abandoned_operation_classification',
          classification: 'abandoned_archive_operation',
          previousOperationStatus: operation.status,
          providerIntentPresent: false,
          policy: 'provider_free_archive_restore',
          offlineBranchLineage: lineage,
        },
        'Capsule archive operation was abandoned.',
      )
    })
  }

  // ---------------------------------------------------------------------------
  // Terminalization mechanics
  // ---------------------------------------------------------------------------

  private async markSafeFailureInTransaction(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    operation: PersistedArchiveOperation,
    error: unknown,
    context: Record<string, unknown>,
    fallbackMessage: string,
  ): Promise<ArchiveCapsuleTerminalResult> {
    if (!isNonterminalArchiveStatus(operation.status)) {
      throw new IncusError('Capsule archive operation is already terminal.', 'CONFLICT', {
        operationId: operation.id,
        operationStatus: operation.status,
      })
    }

    if (operation.providerMutationStartedAt !== null) {
      throw new IncusError(
        'Provider-free capsule archive failure contains contradictory provider-intent evidence.',
        'CONFLICT',
        {
          operationId: operation.id,
          providerMutationStartedAt: operation.providerMutationStartedAt?.toISOString() ?? null,
        },
      )
    }

    const operations = this.persistence.tables.capsuleOperations
    const capsules = this.persistence.tables.capsules
    const failureDetails = createOperationFailureDetails(error, context)
    const now = new Date()

    const [failedOperation] = await tx
      .update(operations)
      .set({
        status: CapsuleOperationStatus.FAILED,
        failedAt: now,
        failureCode: operationFailureCodeFromUnknown(error),
        failureMessage: operationFailureMessageFromUnknown(error, fallbackMessage),
        failureDetails:
          failureDetails === undefined ? undefined : toJsonObject(failureDetails, 'capsule archive failure details'),
        updatedAt: now,
      })
      .where(
        and(
          eq(operations.id, operation.id),
          eq(operations.type, CapsuleOperationType.ARCHIVE),
          inArray(operations.status, NONTERMINAL_ARCHIVE_STATUSES),
          isNull(operations.providerMutationStartedAt),
        ),
      )
      .returning({
        id: operations.id,
      })

    const [restoredCapsule] = await tx
      .update(capsules)
      .set({
        lifecycleStatus: 'active',
        archivedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(capsules.id, operation.capsuleId),
          eq(capsules.ownerId, operation.ownerId),
          eq(capsules.lifecycleStatus, 'archiving'),
          isNull(capsules.archivedAt),
        ),
      )
      .returning({
        lifecycleStatus: capsules.lifecycleStatus,
        archivedAt: capsules.archivedAt,
        destroyedAt: capsules.destroyedAt,
      })

    if (!failedOperation || !restoredCapsule) {
      throw new IncusError('Failed to atomically restore capsule state after archive failure.', 'CONFLICT', {
        operationId: operation.id,
        capsuleId: operation.capsuleId,
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
    operation: PersistedArchiveOperation,
    capsule: ArchivalCapsuleRecord,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<ArchiveCapsuleTerminalResult> {
    if (!isNonterminalArchiveStatus(operation.status)) {
      throw new IncusError('Capsule archive operation is already terminal.', 'CONFLICT', {
        operationId: operation.id,
        operationStatus: operation.status,
      })
    }

    const operations = this.persistence.tables.capsuleOperations
    const capsules = this.persistence.tables.capsules
    const failureDetails = createOperationFailureDetails(error, context)
    const now = new Date()

    const [cleanupOperation] = await tx
      .update(operations)
      .set({
        status: CapsuleOperationStatus.CLEANUP_REQUIRED,
        failedAt: now,
        failureCode: operationFailureCodeFromUnknown(error),
        failureMessage: operationFailureMessageFromUnknown(
          error,
          'Capsule archive requires manual cleanup and inspection.',
        ),
        failureDetails:
          failureDetails === undefined
            ? undefined
            : toJsonObject(failureDetails, 'capsule archive cleanup-required details'),
        updatedAt: now,
      })
      .where(
        and(
          eq(operations.id, operation.id),
          eq(operations.type, CapsuleOperationType.ARCHIVE),
          inArray(operations.status, NONTERMINAL_ARCHIVE_STATUSES),
        ),
      )
      .returning({
        id: operations.id,
      })

    if (!cleanupOperation) {
      throw new IncusError('Failed to mark the capsule archive operation cleanup-required.', 'CONFLICT', {
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
        .update(capsules)
        .set({
          lifecycleStatus: 'cleanup_required',
          updatedAt: now,
        })
        .where(and(eq(capsules.id, operation.capsuleId), eq(capsules.ownerId, operation.ownerId)))
        .returning({
          lifecycleStatus: capsules.lifecycleStatus,
          archivedAt: capsules.archivedAt,
          destroyedAt: capsules.destroyedAt,
        })
      if (!cleanupCapsule) {
        throw new IncusError(
          'Failed to mark the capsule cleanup-required after an archive invariant violation.',
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
  ): Promise<ArchiveCapsuleAcceptanceResult> {
    const capsule = await readOwnedArchivalCapsule(this.persistence, operation.ownerId, operation.capsuleId)
    if (!capsule) {
      throw new IncusError('Capsule archive operation references a missing capsule aggregate.', 'API_ERROR', {
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
  }): CapsuleArchiveReceipt {
    return CapsuleArchiveReceiptSchema.parse({
      operationId: input.operationId,
      operationType: CapsuleOperationType.ARCHIVE,
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
      operationType: CapsuleOperationType.ARCHIVE,
      operationStatus: input.operationStatus,
      capsuleId: input.capsuleId,
    })
  }

  // ---------------------------------------------------------------------------
  // Locking
  // ---------------------------------------------------------------------------

  private async lockArchiveOperation(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    operationId: string,
  ): Promise<PersistedArchiveOperation> {
    const operation = await this.lockArchiveOperationIfPresent(tx, operationId)
    if (!operation) {
      throw new IncusError('Capsule archive operation was not found.', 'NOT_FOUND', {
        operationId,
      })
    }
    if (operation.type !== CapsuleOperationType.ARCHIVE) {
      throw new IncusError('Operation is not a capsule archive operation.', 'CONFLICT', {
        operationId,
        operationType: operation.type,
      })
    }
    return operation
  }

  private async lockArchiveOperationIfPresent(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    operationId: string,
  ): Promise<PersistedArchiveOperation | null> {
    const operations = this.persistence.tables.capsuleOperations
    const [operation] = await tx.select().from(operations).where(eq(operations.id, operationId)).for('update').limit(1)
    return operation ?? null
  }
}
