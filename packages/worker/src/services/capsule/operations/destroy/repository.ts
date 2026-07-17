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
import { completeDestroyCapsule } from './persistence/completion'
import {
  lockDestroyCapsuleBranches,
  lockDestroyOperation,
  lockOwnedDestroyCapsule,
  type DestroyOperationTransaction,
  type PersistedDestroyCapsule,
  type PersistedDestroyOperation,
} from './persistence/locks'
import type {
  AcceptDestroyCapsuleOperationInput,
  DestroyCapsuleAbandonedClassificationResult,
  DestroyCapsuleAcceptedBranch,
  DestroyCapsuleExecutionInput,
  DestroyCapsuleRepositoryResult,
  DestroyCapsuleTerminalResult,
} from './types'

const NONTERMINAL_DESTROY_STATUSES = [CapsuleOperationStatus.ACCEPTED, CapsuleOperationStatus.RUNNING] as const

interface DestroyBranchLineageDescription {
  branchId: string
  capsuleId: string
  ownerId: string
  branchName: string
  status: DestroyCapsuleAcceptedBranch['status']
  isRootBranch: boolean
}

interface DestroyBranchLineageInspection {
  valid: boolean
  branchCount: number
  rootBranchCount: number
  requiredStatus: 'offline' | 'destroying'
  branches: DestroyBranchLineageDescription[]
}

function isNonterminalDestroyStatus(status: CapsuleOperationStatusValue): status is (typeof NONTERMINAL_DESTROY_STATUSES)[number] {
  return status === CapsuleOperationStatus.ACCEPTED || status === CapsuleOperationStatus.RUNNING
}

/**
 * Owns every destroy-specific operation and aggregate transaction.
 *
 * Provider mutation remains outside this repository, but operation-wide
 * provider intent and all aggregate terminal policies are committed here.
 *
 * Execution failure classification always reloads and locks PostgreSQL state.
 * Process-local executor phase and fence observations are diagnostic only and
 * cannot authorize aggregate restoration.
 *
 * Transaction implementations may be delegated to focused persistence modules,
 * while this class remains the single persistence facade consumed by destroy
 * submission, execution, and abandonment capabilities.
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
        const capsule = await lockOwnedDestroyCapsule(tx, input.ownerId, input.capsuleId)
        if (capsule.lifecycleStatus !== 'active' || capsule.archivedAt === null) {
          throw new IncusError('Capsule must be active and archived before it can be destroyed.', 'CONFLICT', {
            ownerId: input.ownerId,
            capsuleId: input.capsuleId,
            lifecycleStatus: capsule.lifecycleStatus,
            archived: capsule.archivedAt !== null,
          })
        }
        const branches = await lockDestroyCapsuleBranches(tx, input.capsuleId)
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
   *
   * A destroy operation is capsule-scoped and must not reference one branch.
   * The null branch predicate is part of the durable compare-and-set fence.
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
          isNull(capsuleOperationsTable.branchId),
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
          isNull(capsuleOperationsTable.branchId),
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
   * Delegates the complete destroy transaction to its focused persistence
   * module.
   *
   * The persistence module owns the complete transaction boundary and returns
   * only committed operation, capsule, and branch state.
   */
  public async complete(operationId: string): Promise<DestroyCapsuleTerminalResult> {
    return await completeDestroyCapsule(this.db, operationId)
  }

  // ---------------------------------------------------------------------------
  // Execution failure classification
  // ---------------------------------------------------------------------------

  /**
   * Classifies a destroy execution failure from any nonterminal phase,
   * including execution-input loading and accepted-to-running claiming.
   *
   * The transaction reloads and locks all durable evidence. It does not trust
   * process-local executor state to decide whether provider intent committed.
   *
   * An intact pre-provider destroy fence becomes an ordinary failed operation
   * and restores the active, archived capsule with every branch offline.
   * Provider intent or contradictory durable evidence becomes
   * cleanup-required.
   *
   * A null result means the operation became terminal before classification
   * acquired its lock. Existing terminal state remains authoritative.
   */
  public async classifyExecutionFailure(
    operationId: string,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<DestroyCapsuleTerminalResult | null> {
    return await this.db.transaction(async tx => {
      const operation = await lockDestroyOperation(tx, operationId)
      if (!isNonterminalDestroyStatus(operation.status)) {
        return null
      }
      const capsule = await lockOwnedDestroyCapsule(tx, operation.ownerId, operation.capsuleId)
      const branches = await lockDestroyCapsuleBranches(tx, operation.capsuleId)
      const lineage = this.inspectBranchLineage(operation.ownerId, operation.capsuleId, branches, 'destroying')
      const safePreProviderFailure =
        operation.providerMutationStartedAt === null &&
        operation.branchId === null &&
        capsule.lifecycleStatus === 'destroying' &&
        capsule.archivedAt !== null &&
        lineage.valid

      const durableContext: Record<string, unknown> = {
        ...context,
        classification: 'destroy_execution_failure',
        previousOperationStatus: operation.status,
        providerIntentPresent: operation.providerMutationStartedAt !== null,
        providerMutationStartedAt: operation.providerMutationStartedAt?.toISOString() ?? null,
        operationBranchId: operation.branchId,
        capsuleLifecycleStatus: capsule.lifecycleStatus,
        capsuleArchived: capsule.archivedAt !== null,
        destroyingBranchLineage: lineage,
      }

      if (safePreProviderFailure) {
        return await this.failBeforeProviderMutationInTransaction(tx, operation, capsule, branches, error, {
          ...durableContext,
          safePreProviderFailure: true,
        })
      }

      return await this.markCleanupRequiredInTransaction(tx, operation, capsule, error, {
        ...durableContext,
        safePreProviderFailure: false,
        invariantViolation: operation.providerMutationStartedAt === null,
        providerOwnershipUncertain: operation.providerMutationStartedAt !== null,
      })
    })
  }

  /**
   * Restores an intact destroy mutation fence after PostgreSQL proves that no
   * provider-intent fence was committed.
   */
  private async failBeforeProviderMutationInTransaction(
    tx: DestroyOperationTransaction,
    operation: PersistedDestroyOperation,
    capsule: PersistedDestroyCapsule,
    branches: readonly DestroyCapsuleAcceptedBranch[],
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<DestroyCapsuleTerminalResult> {
    const lineage = this.inspectBranchLineage(operation.ownerId, operation.capsuleId, branches, 'destroying')

    if (
      !isNonterminalDestroyStatus(operation.status) ||
      operation.providerMutationStartedAt !== null ||
      operation.branchId !== null ||
      capsule.lifecycleStatus !== 'destroying' ||
      capsule.archivedAt === null ||
      !lineage.valid
    ) {
      throw new IncusError('Capsule destroy durable evidence does not prove a safe pre-provider failure.', 'CONFLICT', {
        operationId: operation.id,
        operationStatus: operation.status,
        branchId: operation.branchId,
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
      .update(capsuleOperationsTable)
      .set({
        status: CapsuleOperationStatus.FAILED,
        failedAt: now,
        failureCode: operationFailureCodeFromUnknown(error),
        failureMessage: operationFailureMessageFromUnknown(error, 'Capsule destroy failed before provider mutation.'),
        failureDetails: failureDetails === undefined ? undefined : toJsonObject(failureDetails, 'capsule destroy pre-provider failure details'),
        updatedAt: now,
      })
      .where(
        and(
          eq(capsuleOperationsTable.id, operation.id),
          eq(capsuleOperationsTable.type, CapsuleOperationType.DESTROY),
          inArray(capsuleOperationsTable.status, NONTERMINAL_DESTROY_STATUSES),
          isNull(capsuleOperationsTable.branchId),
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
        operationId: operation.id,
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
        operationId: operation.id,
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
  }

  /**
   * Marks a nonterminal destroy operation and its affected aggregate
   * cleanup-required after provider intent or contradictory durable evidence.
   */
  private async markCleanupRequiredInTransaction(
    tx: DestroyOperationTransaction,
    operation: PersistedDestroyOperation,
    capsule: PersistedDestroyCapsule,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<DestroyCapsuleTerminalResult> {
    if (!isNonterminalDestroyStatus(operation.status)) {
      throw new IncusError('Capsule destroy operation is already terminal.', 'CONFLICT', {
        operationId: operation.id,
        operationStatus: operation.status,
      })
    }

    const failureDetails = createOperationFailureDetails(error, context)
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
          eq(capsuleOperationsTable.id, operation.id),
          eq(capsuleOperationsTable.type, CapsuleOperationType.DESTROY),
          inArray(capsuleOperationsTable.status, NONTERMINAL_DESTROY_STATUSES),
        ),
      )
      .returning({
        id: capsuleOperationsTable.id,
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

    // A terminal destroyed capsule cannot be rewritten without violating its
    // durable destroyed-timestamp invariant.
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
          operationId: operation.id,
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
        operationId: operation.id,
        operationType: CapsuleOperationType.DESTROY,
        operationStatus: CapsuleOperationStatus.CLEANUP_REQUIRED,
        capsuleId: operation.capsuleId,
        branchId: operation.branchId,
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

  // ---------------------------------------------------------------------------
  // Abandoned-operation classification
  // ---------------------------------------------------------------------------

  /**
   * Classifies a destroy operation left nonterminal by a previous Worker.
   *
   * No executor is invoked and no provider state is inspected. The same
   * operation-specific durable evidence used for live execution failures is
   * applied here:
   *
   * - an intact pre-provider destroy fence is restored;
   * - provider intent or contradictory durable state requires cleanup.
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
    return await this.classifyExecutionFailure(operationId, abandonedError, {
      operationId,
      capsuleId: operation.capsuleId,
      phase: 'startup_abandoned_operation_classification',
      action: 'classify_abandoned_destroy_operation',
      policy: 'no_executor_replay_after_worker_restart',
    })
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
  // Durable branch-lineage reads and validation
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

  private inspectBranchLineage(
    ownerId: string,
    capsuleId: string,
    branches: readonly DestroyCapsuleAcceptedBranch[],
    requiredStatus: 'offline' | 'destroying',
  ): DestroyBranchLineageInspection {
    const rootBranchCount = branches.filter(branch => branch.isRootBranch).length
    const valid =
      branches.length > 0 &&
      rootBranchCount === 1 &&
      branches.every(branch => branch.ownerId === ownerId && branch.capsuleId === capsuleId && branch.status === requiredStatus)
    return {
      valid,
      branchCount: branches.length,
      rootBranchCount,
      requiredStatus,
      branches: branches.map(branch => ({
        branchId: branch.id,
        capsuleId: branch.capsuleId,
        ownerId: branch.ownerId,
        branchName: branch.name,
        status: branch.status,
        isRootBranch: branch.isRootBranch,
      })),
    }
  }

  private assertOfflineBranchLineage(ownerId: string, capsuleId: string, branches: readonly DestroyCapsuleAcceptedBranch[]): void {
    const inspection = this.inspectBranchLineage(ownerId, capsuleId, branches, 'offline')
    if (inspection.valid) {
      return
    }
    throw new IncusError('Capsule destroy requires exactly one root branch and every branch offline.', 'CONFLICT', {
      ownerId,
      capsuleId,
      branchCount: inspection.branchCount,
      rootBranchCount: inspection.rootBranchCount,
      branches: inspection.branches,
    })
  }

  private assertDestroyingBranchLineage(ownerId: string, capsuleId: string, branches: readonly DestroyCapsuleAcceptedBranch[]): void {
    const inspection = this.inspectBranchLineage(ownerId, capsuleId, branches, 'destroying')
    if (inspection.valid) {
      return
    }
    throw new IncusError('Capsule destroy requires every durable branch to remain in its destroy fence.', 'CONFLICT', {
      ownerId,
      capsuleId,
      branchCount: inspection.branchCount,
      rootBranchCount: inspection.rootBranchCount,
      branches: inspection.branches,
    })
  }
}
