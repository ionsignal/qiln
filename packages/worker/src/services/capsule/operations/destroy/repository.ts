import { and, asc, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm'
import {
  CapsuleDestroyReceiptSchema,
  CapsuleOperationStatus,
  CapsuleOperationType,
  capsuleBranchesTable,
  capsuleOperationsTable,
  capsulesTable,
  type CapsuleDestroyReceipt,
  type CapsuleHostDbContract,
  type CapsuleOperationRequestHash,
  type CapsuleOperationStatusValue,
} from '@qiln/core/server'
import { IncusError, isUniqueConstraintViolation } from '../../../../errors'
import {
  createFailureDetails as createOperationFailureDetails,
  failureCodeFromUnknown as operationFailureCodeFromUnknown,
  failureMessageFromUnknown as operationFailureMessageFromUnknown,
} from '../../failures'
import {
  assertOperationReplayIdentity,
  toCapsuleLifecycleState,
  toCapsuleOperationTransition,
  type CapsuleOperationReader,
  type CapsuleOperationTransitionOutput,
  type PersistedCapsuleOperation,
} from '../shared'
import { toJsonObject } from '../../stores/jsonPersistence'
import type {
  AcceptDestroyCapsuleOperationInput,
  DestroyCapsuleAbandonedClassificationResult,
  DestroyCapsuleAcceptedBranch,
  DestroyCapsuleExecutionInput,
  DestroyCapsuleRepositoryResult,
  DestroyCapsuleTerminalResult,
} from './types'

const NONTERMINAL_DESTROY_STATUSES = [CapsuleOperationStatus.ACCEPTED, CapsuleOperationStatus.RUNNING] as const

type DestroyTransaction = Parameters<Parameters<CapsuleHostDbContract['transaction']>[0]>[0]
type PersistedDestroyOperation = typeof capsuleOperationsTable.$inferSelect

function isNonterminalDestroyStatus(status: CapsuleOperationStatusValue): status is (typeof NONTERMINAL_DESTROY_STATUSES)[number] {
  return status === CapsuleOperationStatus.ACCEPTED || status === CapsuleOperationStatus.RUNNING
}

/**
 * Owns every destroy-specific operation and aggregate transaction.
 *
 * Provider mutation remains outside this repository, but operation-wide
 * provider intent and all aggregate terminal policies are committed here.
 */
export class DestroyCapsuleOperationRepository {
  constructor(
    private readonly db: CapsuleHostDbContract,
    private readonly reader: CapsuleOperationReader,
  ) {}

  // ---------------------------------------------------------------------------
  // Acceptance and replay
  // ---------------------------------------------------------------------------

  /**
   * Durably accepts or replays one destroy operation.
   *
   * The initial replay lookup handles ordinary idempotent submissions. The
   * replay lookup after a uniqueness violation closes the concurrent acceptance
   * race. Both paths validate operation type and the complete request hash.
   */
  public async acceptOrReplay(input: AcceptDestroyCapsuleOperationInput): Promise<DestroyCapsuleRepositoryResult> {
    const replay = await this.findSubmissionReplay(input.ownerId, input.idempotencyKey, input.requestHash)

    if (replay) {
      return replay
    }

    try {
      return await this.db.transaction(async tx => {
        const capsule = await this.lockCapsule(tx, input.ownerId, input.capsuleId)

        if (capsule.lifecycleStatus !== 'active' || capsule.archivedAt === null) {
          throw new IncusError('Capsule must be active and archived before it can be destroyed.', 'CONFLICT', {
            ownerId: input.ownerId,
            capsuleId: input.capsuleId,
            lifecycleStatus: capsule.lifecycleStatus,
            archived: capsule.archivedAt !== null,
          })
        }

        const branches = await this.lockCapsuleBranches(tx, input.capsuleId)

        this.assertOfflineBranchLineage(input.ownerId, input.capsuleId, branches)

        const now = new Date()

        const [operation] = await tx
          .insert(capsuleOperationsTable)
          .values({
            ownerId: input.ownerId,
            capsuleId: input.capsuleId,
            branchId: null,
            type: CapsuleOperationType.DESTROY,
            status: CapsuleOperationStatus.ACCEPTED,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            acceptedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning({
            id: capsuleOperationsTable.id,
            ownerId: capsuleOperationsTable.ownerId,
            capsuleId: capsuleOperationsTable.capsuleId,
            branchId: capsuleOperationsTable.branchId,
            status: capsuleOperationsTable.status,
          })

        if (!operation) {
          throw new IncusError('Failed to durably accept the capsule destroy operation.', 'API_ERROR')
        }

        if (operation.branchId !== null) {
          throw new IncusError('Accepted capsule destroy operation unexpectedly references one branch.', 'CONFLICT', {
            operationId: operation.id,
            branchId: operation.branchId,
          })
        }

        const [destroyingCapsule] = await tx
          .update(capsulesTable)
          .set({
            lifecycleStatus: 'destroying',
            updatedAt: now,
          })
          .where(
            and(
              eq(capsulesTable.id, input.capsuleId),
              eq(capsulesTable.ownerId, input.ownerId),
              eq(capsulesTable.lifecycleStatus, 'active'),
              isNotNull(capsulesTable.archivedAt),
            ),
          )
          .returning({
            lifecycleStatus: capsulesTable.lifecycleStatus,
            archivedAt: capsulesTable.archivedAt,
            destroyedAt: capsulesTable.destroyedAt,
          })

        if (!destroyingCapsule || destroyingCapsule.archivedAt === null) {
          throw new IncusError('Failed to transition the capsule into its destroy mutation fence.', 'CONFLICT', {
            ownerId: input.ownerId,
            capsuleId: input.capsuleId,
          })
        }

        const transitionedBranches = await tx
          .update(capsuleBranchesTable)
          .set({
            status: 'destroying',
            runtimeIp: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(capsuleBranchesTable.capsuleId, input.capsuleId),
              eq(capsuleBranchesTable.ownerId, input.ownerId),
              eq(capsuleBranchesTable.status, 'offline'),
            ),
          )
          .returning({
            id: capsuleBranchesTable.id,
            capsuleId: capsuleBranchesTable.capsuleId,
            name: capsuleBranchesTable.name,
            status: capsuleBranchesTable.status,
          })

        if (transitionedBranches.length !== branches.length) {
          throw new IncusError('Failed to transition every capsule branch into the destroy mutation fence.', 'CONFLICT', {
            ownerId: input.ownerId,
            capsuleId: input.capsuleId,
            expectedBranchCount: branches.length,
            transitionedBranchCount: transitionedBranches.length,
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
          operation: toCapsuleOperationTransition({
            ownerId: operation.ownerId,
            operationId: operation.id,
            operationType: CapsuleOperationType.DESTROY,
            operationStatus: operation.status,
            capsuleId: operation.capsuleId,
            branchId: null,
          }),
          capsule: toCapsuleLifecycleState({
            capsuleId: operation.capsuleId,
            lifecycleStatus: destroyingCapsule.lifecycleStatus,
            archivedAt: destroyingCapsule.archivedAt,
            destroyedAt: destroyingCapsule.destroyedAt,
          }),
          branches: transitionedBranches,
        }
      })
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) {
        throw error
      }

      const racedReplay = await this.findSubmissionReplay(input.ownerId, input.idempotencyKey, input.requestHash)

      if (racedReplay) {
        return racedReplay
      }

      throw new IncusError('Capsule destroy conflicts with another durable capsule operation.', 'CONFLICT', {
        ownerId: input.ownerId,
        capsuleId: input.capsuleId,
      })
    }
  }

  private async findSubmissionReplay(
    ownerId: string,
    idempotencyKey: string,
    requestHash: CapsuleOperationRequestHash,
  ): Promise<DestroyCapsuleRepositoryResult | null> {
    const operation = await this.reader.loadByOwnerAndIdempotencyKey(ownerId, idempotencyKey)

    if (!operation) {
      return null
    }

    assertOperationReplayIdentity(operation, {
      operationType: CapsuleOperationType.DESTROY,
      requestHash,
      requestDescription: 'capsule destroy',
    })

    return await this.loadAcceptanceResult(operation, false, true)
  }

  // ---------------------------------------------------------------------------
  // Execution input
  // ---------------------------------------------------------------------------

  /**
   * Reloads destroy execution identity and branch lineage entirely from
   * PostgreSQL.
   *
   * The executor receives only the operation ID and never retains the original
   * command payload as execution input.
   */
  public async loadAcceptedExecutionInput(operationId: string): Promise<DestroyCapsuleExecutionInput> {
    const operation = await this.reader.loadById(operationId)

    if (!operation) {
      throw new IncusError('Capsule destroy operation was not found.', 'NOT_FOUND', {
        operationId,
      })
    }

    if (operation.type !== CapsuleOperationType.DESTROY) {
      throw new IncusError('Operation is not a capsule destroy operation.', 'CONFLICT', {
        operationId,
        operationType: operation.type,
      })
    }

    if (operation.status !== CapsuleOperationStatus.ACCEPTED) {
      throw new IncusError('Capsule destroy operation is no longer accepted for execution.', 'CONFLICT', {
        operationId,
        operationStatus: operation.status,
      })
    }

    if (operation.branchId !== null) {
      throw new IncusError('Capsule destroy operation unexpectedly references one branch.', 'CONFLICT', {
        operationId,
        branchId: operation.branchId,
      })
    }

    if (operation.providerMutationStartedAt !== null) {
      throw new IncusError('Accepted capsule destroy operation already contains provider intent.', 'CONFLICT', {
        operationId,
        providerMutationStartedAt: operation.providerMutationStartedAt.toISOString(),
      })
    }

    const [capsule] = await this.db
      .select({
        lifecycleStatus: capsulesTable.lifecycleStatus,
        archivedAt: capsulesTable.archivedAt,
      })
      .from(capsulesTable)
      .where(and(eq(capsulesTable.id, operation.capsuleId), eq(capsulesTable.ownerId, operation.ownerId)))
      .limit(1)

    if (!capsule || capsule.lifecycleStatus !== 'destroying' || capsule.archivedAt === null) {
      throw new IncusError('Capsule destroy aggregate does not match its accepted destroy fence.', 'CONFLICT', {
        operationId,
        capsuleId: operation.capsuleId,
        lifecycleStatus: capsule?.lifecycleStatus ?? null,
        archived: capsule?.archivedAt !== null,
      })
    }

    const branches = await this.loadAcceptedBranches(operation.ownerId, operation.capsuleId)

    this.assertDestroyingBranchLineage(operation.ownerId, operation.capsuleId, branches)

    return {
      operationId: operation.id,
      ownerId: operation.ownerId,
      capsuleId: operation.capsuleId,
      branches,
    }
  }

  // ---------------------------------------------------------------------------
  // Execution claiming and provider-intent fencing
  // ---------------------------------------------------------------------------

  /**
   * Claims one accepted destroy operation for process-local execution.
   */
  public async claimAccepted(operationId: string): Promise<CapsuleOperationTransitionOutput> {
    const now = new Date()

    const [claimed] = await this.db
      .update(capsuleOperationsTable)
      .set({
        status: CapsuleOperationStatus.RUNNING,
        executionStartedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(capsuleOperationsTable.id, operationId),
          eq(capsuleOperationsTable.type, CapsuleOperationType.DESTROY),
          eq(capsuleOperationsTable.status, CapsuleOperationStatus.ACCEPTED),
          isNull(capsuleOperationsTable.providerMutationStartedAt),
        ),
      )
      .returning({
        ownerId: capsuleOperationsTable.ownerId,
        capsuleId: capsuleOperationsTable.capsuleId,
        branchId: capsuleOperationsTable.branchId,
        status: capsuleOperationsTable.status,
      })

    if (!claimed) {
      throw new IncusError('Capsule destroy operation could not be claimed from accepted to running.', 'CONFLICT', {
        operationId,
      })
    }

    if (claimed.branchId !== null) {
      throw new IncusError('Claimed capsule destroy operation unexpectedly references one branch.', 'CONFLICT', {
        operationId,
        branchId: claimed.branchId,
      })
    }

    return toCapsuleOperationTransition({
      ownerId: claimed.ownerId,
      operationId,
      operationType: CapsuleOperationType.DESTROY,
      operationStatus: claimed.status,
      capsuleId: claimed.capsuleId,
      branchId: null,
    })
  }

  /**
   * Commits the operation-wide provider-intent fence.
   *
   * This write must complete before any instance stop, instance deletion,
   * volume deletion, or other provider mutation.
   */
  public async commitProviderIntentFence(operationId: string): Promise<void> {
    const now = new Date()

    const updated = await this.db
      .update(capsuleOperationsTable)
      .set({
        providerMutationStartedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(capsuleOperationsTable.id, operationId),
          eq(capsuleOperationsTable.type, CapsuleOperationType.DESTROY),
          eq(capsuleOperationsTable.status, CapsuleOperationStatus.RUNNING),
          isNull(capsuleOperationsTable.providerMutationStartedAt),
        ),
      )
      .returning({
        id: capsuleOperationsTable.id,
      })

    if (updated.length !== 1) {
      throw new IncusError('Failed to commit the capsule destroy provider-intent fence.', 'CONFLICT', {
        operationId,
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Successful completion
  // ---------------------------------------------------------------------------

  /**
   * Atomically commits terminal capsule destruction after resource outcomes have
   * been verified by the executor.
   */
  public async complete(operationId: string): Promise<DestroyCapsuleTerminalResult> {
    return await this.db.transaction(async tx => {
      const operation = await this.lockDestroyOperation(tx, operationId)

      if (operation.status !== CapsuleOperationStatus.RUNNING || operation.providerMutationStartedAt === null || operation.branchId !== null) {
        throw new IncusError('Capsule destroy operation is not eligible for successful completion.', 'CONFLICT', {
          operationId,
          operationStatus: operation.status,
          branchId: operation.branchId,
          hasProviderIntent: operation.providerMutationStartedAt !== null,
        })
      }

      const capsule = await this.lockCapsule(tx, operation.ownerId, operation.capsuleId)
      const branches = await this.lockCapsuleBranches(tx, operation.capsuleId)

      this.assertDestroyingBranchLineage(operation.ownerId, operation.capsuleId, branches)

      if (capsule.lifecycleStatus !== 'destroying' || capsule.archivedAt === null) {
        throw new IncusError('Capsule aggregate is not eligible for terminal destroy completion.', 'CONFLICT', {
          operationId,
          capsuleId: operation.capsuleId,
          lifecycleStatus: capsule.lifecycleStatus,
          archived: capsule.archivedAt !== null,
        })
      }

      const now = new Date()

      const [completedOperation] = await tx
        .update(capsuleOperationsTable)
        .set({
          status: CapsuleOperationStatus.COMPLETED,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleOperationsTable.id, operationId),
            eq(capsuleOperationsTable.type, CapsuleOperationType.DESTROY),
            eq(capsuleOperationsTable.status, CapsuleOperationStatus.RUNNING),
            isNotNull(capsuleOperationsTable.providerMutationStartedAt),
          ),
        )
        .returning({
          id: capsuleOperationsTable.id,
        })

      const [destroyedCapsule] = await tx
        .update(capsulesTable)
        .set({
          lifecycleStatus: 'destroyed',
          destroyedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(capsulesTable.id, operation.capsuleId),
            eq(capsulesTable.ownerId, operation.ownerId),
            eq(capsulesTable.lifecycleStatus, 'destroying'),
            isNotNull(capsulesTable.archivedAt),
          ),
        )
        .returning({
          lifecycleStatus: capsulesTable.lifecycleStatus,
          archivedAt: capsulesTable.archivedAt,
          destroyedAt: capsulesTable.destroyedAt,
        })

      const destroyedBranches = await tx
        .update(capsuleBranchesTable)
        .set({
          status: 'destroyed',
          runtimeIp: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleBranchesTable.capsuleId, operation.capsuleId),
            eq(capsuleBranchesTable.ownerId, operation.ownerId),
            eq(capsuleBranchesTable.status, 'destroying'),
          ),
        )
        .returning({
          id: capsuleBranchesTable.id,
          capsuleId: capsuleBranchesTable.capsuleId,
          name: capsuleBranchesTable.name,
          status: capsuleBranchesTable.status,
        })

      if (!completedOperation || !destroyedCapsule || destroyedCapsule.destroyedAt === null || destroyedBranches.length !== branches.length) {
        throw new IncusError('Failed to atomically complete capsule destroy.', 'CONFLICT', {
          operationId,
          capsuleId: operation.capsuleId,
          expectedBranchCount: branches.length,
          destroyedBranchCount: destroyedBranches.length,
        })
      }

      return {
        operation: toCapsuleOperationTransition({
          ownerId: operation.ownerId,
          operationId,
          operationType: CapsuleOperationType.DESTROY,
          operationStatus: CapsuleOperationStatus.COMPLETED,
          capsuleId: operation.capsuleId,
          branchId: null,
        }),
        capsule: toCapsuleLifecycleState({
          capsuleId: operation.capsuleId,
          lifecycleStatus: destroyedCapsule.lifecycleStatus,
          archivedAt: destroyedCapsule.archivedAt,
          destroyedAt: destroyedCapsule.destroyedAt,
        }),
        branches: destroyedBranches,
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Pre-provider failure
  // ---------------------------------------------------------------------------

  /**
   * Restores an intact destroy mutation fence after a failure proven to have
   * occurred before provider intent.
   */
  public async failBeforeProviderMutation(
    operationId: string,
    error: unknown,
    context?: Record<string, unknown>,
  ): Promise<DestroyCapsuleTerminalResult> {
    const result = await this.finalizeFailureBeforeProviderMutation(operationId, error, context, false)

    if (!result) {
      throw new IncusError('Capsule destroy operation became terminal before failure finalization.', 'CONFLICT', {
        operationId,
      })
    }

    return result
  }

  private async finalizeFailureBeforeProviderMutation(
    operationId: string,
    error: unknown,
    context: Record<string, unknown> | undefined,
    allowNoChange: boolean,
  ): Promise<DestroyCapsuleTerminalResult | null> {
    const failureDetails = createOperationFailureDetails(error, context)

    return await this.db.transaction(async tx => {
      const operation = await this.lockDestroyOperation(tx, operationId)

      if (!isNonterminalDestroyStatus(operation.status)) {
        if (allowNoChange) {
          return null
        }

        throw new IncusError('Capsule destroy operation is already terminal.', 'CONFLICT', {
          operationId,
          operationStatus: operation.status,
        })
      }

      if (operation.providerMutationStartedAt !== null) {
        throw new IncusError('Capsule destroy cannot restore aggregate state after provider intent.', 'CONFLICT', {
          operationId,
          providerMutationStartedAt: operation.providerMutationStartedAt.toISOString(),
        })
      }

      const capsule = await this.lockCapsule(tx, operation.ownerId, operation.capsuleId)
      const branches = await this.lockCapsuleBranches(tx, operation.capsuleId)

      this.assertDestroyingBranchLineage(operation.ownerId, operation.capsuleId, branches)

      if (capsule.lifecycleStatus !== 'destroying' || capsule.archivedAt === null) {
        throw new IncusError('Capsule destroy fence is not eligible for restoration before provider mutation.', 'CONFLICT', {
          operationId,
          capsuleId: operation.capsuleId,
          lifecycleStatus: capsule.lifecycleStatus,
          archived: capsule.archivedAt !== null,
        })
      }

      const originalArchivedAt = capsule.archivedAt
      const now = new Date()

      const [failedOperation] = await tx
        .update(capsuleOperationsTable)
        .set({
          status: CapsuleOperationStatus.FAILED,
          failedAt: now,
          failureCode: operationFailureCodeFromUnknown(error),
          failureMessage: operationFailureMessageFromUnknown(error, 'Capsule destroy failed before provider mutation.'),
          failureDetails:
            failureDetails === undefined ? undefined : toJsonObject(failureDetails, 'capsule destroy pre-provider failure details'),
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleOperationsTable.id, operationId),
            eq(capsuleOperationsTable.type, CapsuleOperationType.DESTROY),
            inArray(capsuleOperationsTable.status, NONTERMINAL_DESTROY_STATUSES),
            isNull(capsuleOperationsTable.providerMutationStartedAt),
          ),
        )
        .returning({
          id: capsuleOperationsTable.id,
        })

      const [restoredCapsule] = await tx
        .update(capsulesTable)
        .set({
          lifecycleStatus: 'active',
          updatedAt: now,
        })
        .where(
          and(
            eq(capsulesTable.id, operation.capsuleId),
            eq(capsulesTable.ownerId, operation.ownerId),
            eq(capsulesTable.lifecycleStatus, 'destroying'),
            isNotNull(capsulesTable.archivedAt),
          ),
        )
        .returning({
          lifecycleStatus: capsulesTable.lifecycleStatus,
          archivedAt: capsulesTable.archivedAt,
          destroyedAt: capsulesTable.destroyedAt,
        })

      const restoredBranches = await tx
        .update(capsuleBranchesTable)
        .set({
          status: 'offline',
          runtimeIp: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleBranchesTable.capsuleId, operation.capsuleId),
            eq(capsuleBranchesTable.ownerId, operation.ownerId),
            eq(capsuleBranchesTable.status, 'destroying'),
          ),
        )
        .returning({
          id: capsuleBranchesTable.id,
          capsuleId: capsuleBranchesTable.capsuleId,
          name: capsuleBranchesTable.name,
          status: capsuleBranchesTable.status,
        })

      if (
        !failedOperation ||
        !restoredCapsule ||
        restoredCapsule.archivedAt === null ||
        restoredCapsule.archivedAt.getTime() !== originalArchivedAt.getTime() ||
        restoredBranches.length !== branches.length
      ) {
        throw new IncusError('Failed to atomically restore capsule state after pre-provider destroy failure.', 'CONFLICT', {
          operationId,
          capsuleId: operation.capsuleId,
          expectedBranchCount: branches.length,
          restoredBranchCount: restoredBranches.length,
          originalArchivedAt: originalArchivedAt.toISOString(),
          restoredArchivedAt: restoredCapsule?.archivedAt?.toISOString() ?? null,
        })
      }

      return {
        operation: toCapsuleOperationTransition({
          ownerId: operation.ownerId,
          operationId,
          operationType: CapsuleOperationType.DESTROY,
          operationStatus: CapsuleOperationStatus.FAILED,
          capsuleId: operation.capsuleId,
          branchId: null,
        }),
        capsule: toCapsuleLifecycleState({
          capsuleId: operation.capsuleId,
          lifecycleStatus: restoredCapsule.lifecycleStatus,
          archivedAt: restoredCapsule.archivedAt,
          destroyedAt: restoredCapsule.destroyedAt,
        }),
        branches: restoredBranches,
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Cleanup-required classification
  // ---------------------------------------------------------------------------

  /**
   * Marks a nonterminal destroy operation and its affected aggregate
   * cleanup-required after provider intent or contradictory durable evidence.
   */
  public async requireCleanup(operationId: string, error: unknown, context?: Record<string, unknown>): Promise<DestroyCapsuleTerminalResult> {
    const result = await this.markCleanupRequired(operationId, error, context, false)

    if (!result) {
      throw new IncusError('Capsule destroy operation became terminal before cleanup classification.', 'CONFLICT', {
        operationId,
      })
    }

    return result
  }

  private async markCleanupRequired(
    operationId: string,
    error: unknown,
    context: Record<string, unknown> | undefined,
    allowNoChange: boolean,
  ): Promise<DestroyCapsuleTerminalResult | null> {
    const failureDetails = createOperationFailureDetails(error, context)

    return await this.db.transaction(async tx => {
      const operation = await this.lockDestroyOperation(tx, operationId)

      if (!isNonterminalDestroyStatus(operation.status)) {
        if (allowNoChange) {
          return null
        }

        throw new IncusError('Capsule destroy operation is already terminal.', 'CONFLICT', {
          operationId,
          operationStatus: operation.status,
        })
      }

      const capsule = await this.lockCapsule(tx, operation.ownerId, operation.capsuleId)

      await this.lockCapsuleBranches(tx, operation.capsuleId)

      const now = new Date()

      const [cleanupOperation] = await tx
        .update(capsuleOperationsTable)
        .set({
          status: CapsuleOperationStatus.CLEANUP_REQUIRED,
          failedAt: now,
          failureCode: operationFailureCodeFromUnknown(error),
          failureMessage: operationFailureMessageFromUnknown(error, 'Capsule destroy requires manual cleanup and inspection.'),
          failureDetails: failureDetails === undefined ? undefined : toJsonObject(failureDetails, 'capsule destroy cleanup-required details'),
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleOperationsTable.id, operationId),
            eq(capsuleOperationsTable.type, CapsuleOperationType.DESTROY),
            inArray(capsuleOperationsTable.status, NONTERMINAL_DESTROY_STATUSES),
          ),
        )
        .returning({
          id: capsuleOperationsTable.id,
        })

      if (!cleanupOperation) {
        if (allowNoChange) {
          return null
        }

        throw new IncusError('Failed to mark capsule destroy operation cleanup-required.', 'CONFLICT', {
          operationId,
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
          .update(capsulesTable)
          .set({
            lifecycleStatus: 'cleanup_required',
            updatedAt: now,
          })
          .where(
            and(
              eq(capsulesTable.id, operation.capsuleId),
              eq(capsulesTable.ownerId, operation.ownerId),
              ne(capsulesTable.lifecycleStatus, 'destroyed'),
            ),
          )
          .returning({
            lifecycleStatus: capsulesTable.lifecycleStatus,
            archivedAt: capsulesTable.archivedAt,
            destroyedAt: capsulesTable.destroyedAt,
          })

        if (!cleanupCapsule) {
          throw new IncusError('Failed to mark capsule aggregate cleanup-required after destroy uncertainty.', 'CONFLICT', {
            operationId,
            capsuleId: operation.capsuleId,
          })
        }

        committedCapsule = cleanupCapsule
      }

      await tx
        .update(capsuleBranchesTable)
        .set({
          status: 'cleanup_required',
          runtimeIp: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleBranchesTable.capsuleId, operation.capsuleId),
            eq(capsuleBranchesTable.ownerId, operation.ownerId),
            ne(capsuleBranchesTable.status, 'destroyed'),
          ),
        )

      const committedBranches = await tx
        .select({
          id: capsuleBranchesTable.id,
          capsuleId: capsuleBranchesTable.capsuleId,
          name: capsuleBranchesTable.name,
          status: capsuleBranchesTable.status,
        })
        .from(capsuleBranchesTable)
        .where(and(eq(capsuleBranchesTable.capsuleId, operation.capsuleId), eq(capsuleBranchesTable.ownerId, operation.ownerId)))
        .orderBy(asc(capsuleBranchesTable.id))

      return {
        operation: toCapsuleOperationTransition({
          ownerId: operation.ownerId,
          operationId,
          operationType: CapsuleOperationType.DESTROY,
          operationStatus: CapsuleOperationStatus.CLEANUP_REQUIRED,
          capsuleId: operation.capsuleId,
          branchId: null,
        }),
        capsule: toCapsuleLifecycleState({
          capsuleId: operation.capsuleId,
          lifecycleStatus: committedCapsule.lifecycleStatus,
          archivedAt: committedCapsule.archivedAt,
          destroyedAt: committedCapsule.destroyedAt,
        }),
        branches: committedBranches,
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Abandoned-operation classification
  // ---------------------------------------------------------------------------

  /**
   * Classifies a destroy operation left nonterminal by a previous Worker.
   *
   * No executor is invoked and no provider state is inspected. An intact
   * pre-provider destroy fence is restored. Provider intent or contradictory
   * durable evidence requires cleanup.
   */
  public async classifyAbandoned(operationId: string): Promise<DestroyCapsuleAbandonedClassificationResult> {
    const operation = await this.reader.loadById(operationId)

    if (!operation || operation.type !== CapsuleOperationType.DESTROY || !isNonterminalDestroyStatus(operation.status)) {
      return null
    }

    const abandonedError = new IncusError('Capsule destroy operation was abandoned by a previous Worker process.', 'API_ERROR', {
      operationId,
      capsuleId: operation.capsuleId,
      providerMutationStartedAt: operation.providerMutationStartedAt,
      policy: 'no_provider_mutation_after_restart',
    })

    if (operation.providerMutationStartedAt !== null) {
      return await this.markCleanupRequired(
        operationId,
        abandonedError,
        {
          operationId,
          capsuleId: operation.capsuleId,
          phase: 'startup_abandoned_operation_classification',
          providerIntentCommitted: true,
          providerOwnershipUncertain: true,
        },
        true,
      )
    }

    try {
      return await this.finalizeFailureBeforeProviderMutation(
        operationId,
        abandonedError,
        {
          operationId,
          capsuleId: operation.capsuleId,
          phase: 'startup_abandoned_operation_classification',
          providerIntentCommitted: false,
          policy: 'restore_active_archived_capsule_before_provider_intent',
        },
        true,
      )
    } catch (classificationError: unknown) {
      return await this.markCleanupRequired(
        operationId,
        classificationError,
        {
          operationId,
          capsuleId: operation.capsuleId,
          phase: 'startup_abandoned_operation_classification',
          action: 'classify_destroy_invariant_conflict_cleanup_required',
          providerIntentCommitted: false,
          invariantViolation: true,
          originalAbandonedError: abandonedError.message,
        },
        true,
      )
    }
  }

  // ---------------------------------------------------------------------------
  // Result mapping
  // ---------------------------------------------------------------------------

  private async loadAcceptanceResult(
    operation: PersistedCapsuleOperation,
    newlyAccepted: boolean,
    replayed: boolean,
  ): Promise<DestroyCapsuleRepositoryResult> {
    if (operation.branchId !== null) {
      throw new IncusError('Capsule destroy operation unexpectedly references one branch.', 'CONFLICT', {
        operationId: operation.id,
        branchId: operation.branchId,
      })
    }

    const [capsule] = await this.db
      .select({
        lifecycleStatus: capsulesTable.lifecycleStatus,
        archivedAt: capsulesTable.archivedAt,
        destroyedAt: capsulesTable.destroyedAt,
      })
      .from(capsulesTable)
      .where(and(eq(capsulesTable.id, operation.capsuleId), eq(capsulesTable.ownerId, operation.ownerId)))
      .limit(1)

    if (!capsule) {
      throw new IncusError('Capsule destroy operation references a missing capsule aggregate.', 'API_ERROR', {
        operationId: operation.id,
        capsuleId: operation.capsuleId,
      })
    }

    const branches = await this.db
      .select({
        id: capsuleBranchesTable.id,
        capsuleId: capsuleBranchesTable.capsuleId,
        name: capsuleBranchesTable.name,
        status: capsuleBranchesTable.status,
      })
      .from(capsuleBranchesTable)
      .where(and(eq(capsuleBranchesTable.capsuleId, operation.capsuleId), eq(capsuleBranchesTable.ownerId, operation.ownerId)))
      .orderBy(asc(capsuleBranchesTable.id))

    return {
      newlyAccepted,
      receipt: this.createReceipt({
        operationId: operation.id,
        capsuleId: operation.capsuleId,
        operationStatus: operation.status,
        replayed,
      }),
      operation: toCapsuleOperationTransition({
        ownerId: operation.ownerId,
        operationId: operation.id,
        operationType: CapsuleOperationType.DESTROY,
        operationStatus: operation.status,
        capsuleId: operation.capsuleId,
        branchId: null,
      }),
      capsule: toCapsuleLifecycleState({
        capsuleId: operation.capsuleId,
        lifecycleStatus: capsule.lifecycleStatus,
        archivedAt: capsule.archivedAt,
        destroyedAt: capsule.destroyedAt,
      }),
      branches,
    }
  }

  private createReceipt(input: {
    operationId: string
    capsuleId: string
    operationStatus: CapsuleOperationStatusValue
    replayed: boolean
  }): CapsuleDestroyReceipt {
    return CapsuleDestroyReceiptSchema.parse({
      operationId: input.operationId,
      operationType: CapsuleOperationType.DESTROY,
      operationStatus: input.operationStatus,
      capsuleId: input.capsuleId,
      replayed: input.replayed,
    })
  }

  // ---------------------------------------------------------------------------
  // Locking and durable lineage validation
  // ---------------------------------------------------------------------------

  private async loadAcceptedBranches(ownerId: string, capsuleId: string): Promise<DestroyCapsuleAcceptedBranch[]> {
    return await this.db
      .select({
        id: capsuleBranchesTable.id,
        capsuleId: capsuleBranchesTable.capsuleId,
        ownerId: capsuleBranchesTable.ownerId,
        name: capsuleBranchesTable.name,
        status: capsuleBranchesTable.status,
        isRootBranch: capsuleBranchesTable.isRootBranch,
        resourceInventoryDigest: capsuleBranchesTable.resourceInventoryDigest,
      })
      .from(capsuleBranchesTable)
      .where(and(eq(capsuleBranchesTable.ownerId, ownerId), eq(capsuleBranchesTable.capsuleId, capsuleId)))
      .orderBy(asc(capsuleBranchesTable.id))
  }

  private async lockDestroyOperation(tx: DestroyTransaction, operationId: string): Promise<PersistedDestroyOperation> {
    const [operation] = await tx
      .select()
      .from(capsuleOperationsTable)
      .where(and(eq(capsuleOperationsTable.id, operationId), eq(capsuleOperationsTable.type, CapsuleOperationType.DESTROY)))
      .for('update')
      .limit(1)

    if (!operation) {
      throw new IncusError('Capsule destroy operation was not found.', 'NOT_FOUND', {
        operationId,
      })
    }

    return operation
  }

  private async lockCapsule(tx: DestroyTransaction, ownerId: string, capsuleId: string) {
    const [capsule] = await tx
      .select()
      .from(capsulesTable)
      .where(and(eq(capsulesTable.id, capsuleId), eq(capsulesTable.ownerId, ownerId)))
      .for('update')
      .limit(1)

    if (!capsule) {
      throw new IncusError('Capsule not found or access denied.', 'NOT_FOUND', {
        ownerId,
        capsuleId,
      })
    }

    return capsule
  }

  private async lockCapsuleBranches(tx: DestroyTransaction, capsuleId: string) {
    return await tx
      .select({
        id: capsuleBranchesTable.id,
        capsuleId: capsuleBranchesTable.capsuleId,
        ownerId: capsuleBranchesTable.ownerId,
        name: capsuleBranchesTable.name,
        status: capsuleBranchesTable.status,
        isRootBranch: capsuleBranchesTable.isRootBranch,
        resourceInventoryDigest: capsuleBranchesTable.resourceInventoryDigest,
      })
      .from(capsuleBranchesTable)
      .where(eq(capsuleBranchesTable.capsuleId, capsuleId))
      .orderBy(asc(capsuleBranchesTable.id))
      .for('update')
  }

  private assertOfflineBranchLineage(
    ownerId: string,
    capsuleId: string,
    branches: readonly {
      id: string
      capsuleId: string
      ownerId: string
      name: string
      status: string
      isRootBranch: boolean
    }[],
  ): void {
    const rootBranchCount = branches.filter(branch => branch.isRootBranch).length

    if (
      branches.length === 0 ||
      rootBranchCount !== 1 ||
      branches.some(branch => branch.ownerId !== ownerId || branch.capsuleId !== capsuleId || branch.status !== 'offline')
    ) {
      throw new IncusError('Capsule destroy requires exactly one root branch and every branch offline.', 'CONFLICT', {
        ownerId,
        capsuleId,
        branchCount: branches.length,
        rootBranchCount,
        branches: branches.map(branch => ({
          branchId: branch.id,
          branchOwnerId: branch.ownerId,
          branchCapsuleId: branch.capsuleId,
          branchName: branch.name,
          status: branch.status,
          isRootBranch: branch.isRootBranch,
        })),
      })
    }
  }

  private assertDestroyingBranchLineage(
    ownerId: string,
    capsuleId: string,
    branches: readonly {
      id: string
      capsuleId: string
      ownerId: string
      name: string
      status: string
      isRootBranch: boolean
    }[],
  ): void {
    const rootBranchCount = branches.filter(branch => branch.isRootBranch).length

    if (
      branches.length === 0 ||
      rootBranchCount !== 1 ||
      branches.some(branch => branch.ownerId !== ownerId || branch.capsuleId !== capsuleId || branch.status !== 'destroying')
    ) {
      throw new IncusError('Capsule destroy requires every durable branch to remain in its destroy fence.', 'CONFLICT', {
        ownerId,
        capsuleId,
        branchCount: branches.length,
        rootBranchCount,
        branches: branches.map(branch => ({
          branchId: branch.id,
          branchOwnerId: branch.ownerId,
          branchCapsuleId: branch.capsuleId,
          branchName: branch.name,
          status: branch.status,
          isRootBranch: branch.isRootBranch,
        })),
      })
    }
  }
}
