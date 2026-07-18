import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm'
import {
  CapsuleBlueprintDigestSchema,
  CapsuleCreateReceiptSchema,
  CapsuleLifecycleStateSchema,
  CapsuleOperationStatus,
  CapsuleOperationType,
  capsuleBranchesTable,
  capsuleBranchResourcesTable,
  capsuleOperationsTable,
  capsulesTable,
  type CapsuleBranchResourceInventoryDigest,
  type CapsuleCreateReceipt,
  type CapsuleHostDbContract,
  type CapsuleOperationRequestHash,
  type CapsuleOperationStatusValue,
} from '@qiln/core/server'
import { IncusError, isUniqueConstraintViolation } from '../../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from '../../failures'
import {
  assertOperationReplayIdentity,
  toCapsuleOperationTransition,
  toNullableIsoTimestamp,
  type CapsuleOperationReader,
  type PersistedCapsuleOperation,
} from '../shared'
import { toJsonObject } from '../../persistence/json'
import type {
  AcceptCreateCapsuleOperationInput,
  CreateCapsuleCommittedBranch,
  CreateCapsuleExecutionInput,
  CreateCapsuleRepositoryResult,
  CreateCapsuleTerminalResult,
} from './types'

const NONTERMINAL_CREATE_STATUSES = [CapsuleOperationStatus.ACCEPTED, CapsuleOperationStatus.RUNNING] as const

type CreateTransaction = Parameters<Parameters<CapsuleHostDbContract['transaction']>[0]>[0]
type PersistedCreateOperation = typeof capsuleOperationsTable.$inferSelect
type PersistedCapsule = typeof capsulesTable.$inferSelect
type PersistedCapsuleBranch = typeof capsuleBranchesTable.$inferSelect

interface PreProviderResourceEvidence {
  id: string
  branchId: string | null
  resourceKey: string
  resourceType: string
  status: string
  createdByOperationId: string | null
  lastOperationId: string | null
}

function isNonterminalCreateStatus(status: CapsuleOperationStatusValue): status is (typeof NONTERMINAL_CREATE_STATUSES)[number] {
  return status === CapsuleOperationStatus.ACCEPTED || status === CapsuleOperationStatus.RUNNING
}

/**
 * Owns every create-specific operation and aggregate transaction.
 *
 * This repository is the authoritative persistence boundary for create
 * acceptance, immutable execution input, mutation fences, terminal aggregate
 * transitions, and abandoned-create classification.
 */
export class CreateCapsuleOperationRepository {
  constructor(
    private readonly db: CapsuleHostDbContract,
    private readonly reader: CapsuleOperationReader,
  ) {}

  // ---------------------------------------------------------------------------
  // Replay and acceptance
  // ---------------------------------------------------------------------------

  /**
   * Loads and validates an existing operation for an idempotent create replay.
   *
   * The submission service calls this before blueprint pinning so a valid
   * replay does not depend on current mutable catalog state. `acceptCreate()`
   * repeats the lookup to provide race-safe durable idempotency.
   */
  public async findIdempotentReplay(
    ownerId: string,
    idempotencyKey: string,
    requestHash: CapsuleOperationRequestHash,
  ): Promise<CreateCapsuleRepositoryResult | null> {
    const operation = await this.reader.loadByOwnerAndIdempotencyKey(ownerId, idempotencyKey)

    if (!operation) {
      return null
    }

    this.assertIdempotentReplay(operation, requestHash)

    return await this.loadCreateResult(operation, false, true)
  }

  /**
   * Atomically accepts a create operation, creates its capsule aggregate and
   * root branch, and links the base operation to that branch.
   */
  public async acceptCreate(input: AcceptCreateCapsuleOperationInput): Promise<CreateCapsuleRepositoryResult> {
    const replay = await this.findIdempotentReplay(input.ownerId, input.idempotencyKey, input.requestHash)

    if (replay) {
      return replay
    }

    try {
      return await this.db.transaction(async tx => {
        const now = new Date()

        const [capsule] = await tx
          .insert(capsulesTable)
          .values({
            ownerId: input.ownerId,
            lifecycleStatus: 'provisioning',
            createdAt: now,
            updatedAt: now,
          })
          .returning({
            id: capsulesTable.id,
            lifecycleStatus: capsulesTable.lifecycleStatus,
            archivedAt: capsulesTable.archivedAt,
            destroyedAt: capsulesTable.destroyedAt,
          })

        if (!capsule) {
          throw new IncusError('Failed to create the durable capsule aggregate.', 'API_ERROR')
        }

        const [operation] = await tx
          .insert(capsuleOperationsTable)
          .values({
            ownerId: input.ownerId,
            capsuleId: capsule.id,
            type: CapsuleOperationType.CREATE,
            status: CapsuleOperationStatus.ACCEPTED,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            branchName: input.rootBranchName,
            blueprintName: input.blueprintName,
            blueprintDigest: input.blueprintDigest,
            blueprintSnapshot: input.blueprintSnapshot,
            acceptedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning({
            id: capsuleOperationsTable.id,
          })

        if (!operation) {
          throw new IncusError('Failed to accept the durable capsule create operation.', 'API_ERROR')
        }

        const [branch] = await tx
          .insert(capsuleBranchesTable)
          .values({
            ownerId: input.ownerId,
            capsuleId: capsule.id,
            name: input.rootBranchName,
            cpu: input.cpu,
            memory: input.memory,
            blueprintName: input.blueprintName,
            blueprintDigest: input.blueprintDigest,
            status: 'provisioning',
            isRootBranch: true,
            createdAt: now,
            updatedAt: now,
          })
          .returning({
            id: capsuleBranchesTable.id,
            capsuleId: capsuleBranchesTable.capsuleId,
            name: capsuleBranchesTable.name,
            status: capsuleBranchesTable.status,
          })

        if (!branch) {
          throw new IncusError('Failed to create the provisional capsule root branch.', 'API_ERROR')
        }

        const linkedOperations = await tx
          .update(capsuleOperationsTable)
          .set({
            branchId: branch.id,
            updatedAt: now,
          })
          .where(
            and(
              eq(capsuleOperationsTable.id, operation.id),
              eq(capsuleOperationsTable.status, CapsuleOperationStatus.ACCEPTED),
              isNull(capsuleOperationsTable.branchId),
            ),
          )
          .returning({
            id: capsuleOperationsTable.id,
          })

        if (linkedOperations.length !== 1) {
          throw new IncusError('Failed to link the accepted create operation to its root branch.', 'CONFLICT')
        }

        return {
          newlyAccepted: true,
          receipt: this.createCreateReceipt({
            operationId: operation.id,
            capsuleId: capsule.id,
            rootBranchId: branch.id,
            rootBranchName: branch.name,
            operationStatus: CapsuleOperationStatus.ACCEPTED,
            replayed: false,
          }),
          operation: toCapsuleOperationTransition({
            ownerId: input.ownerId,
            operationId: operation.id,
            capsuleId: capsule.id,
            branchId: branch.id,
            operationType: CapsuleOperationType.CREATE,
            operationStatus: CapsuleOperationStatus.ACCEPTED,
          }),
          capsule: CapsuleLifecycleStateSchema.parse({
            capsuleId: capsule.id,
            lifecycleStatus: capsule.lifecycleStatus,
            archivedAt: toNullableIsoTimestamp(capsule.archivedAt, 'archivedAt', {
              entity: 'capsule',
              entityId: capsule.id,
            }),
            destroyedAt: toNullableIsoTimestamp(capsule.destroyedAt, 'destroyedAt', {
              entity: 'capsule',
              entityId: capsule.id,
            }),
          }),
          branch,
        }
      })
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) {
        throw error
      }

      /**
       * A concurrent request may have committed the same idempotency key after
       * the preflight lookup. Reloading here is the race-safe half of the
       * idempotency protocol.
       */
      const racedReplay = await this.findIdempotentReplay(input.ownerId, input.idempotencyKey, input.requestHash)

      if (racedReplay) {
        return racedReplay
      }

      throw new IncusError(`Capsule root branch '${input.rootBranchName}' conflicts with existing durable state.`, 'CONFLICT', {
        ownerId: input.ownerId,
        rootBranchName: input.rootBranchName,
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Immutable execution input and mutation fences
  // ---------------------------------------------------------------------------

  /**
   * Reloads immutable create execution input exclusively from PostgreSQL.
   *
   * The executor receives only the operation ID and cannot retain or reuse the
   * original transport payload.
   */
  public async loadAcceptedExecutionInput(operationId: string): Promise<CreateCapsuleExecutionInput> {
    const operation = await this.reader.loadById(operationId)

    if (!operation) {
      throw new IncusError('Capsule create operation was not found.', 'NOT_FOUND', {
        operationId,
      })
    }

    if (operation.type !== CapsuleOperationType.CREATE) {
      throw new IncusError('Operation is not a capsule create operation.', 'CONFLICT', {
        operationId,
        operationType: operation.type,
      })
    }

    if (operation.status !== CapsuleOperationStatus.ACCEPTED) {
      throw new IncusError('Capsule create operation is no longer accepted for execution.', 'CONFLICT', {
        operationId,
        operationStatus: operation.status,
      })
    }

    if (operation.providerMutationStartedAt !== null) {
      throw new IncusError('Accepted capsule create operation already contains provider intent.', 'CONFLICT', {
        operationId,
        providerMutationStartedAt: operation.providerMutationStartedAt.toISOString(),
      })
    }

    if (
      !operation.branchId ||
      !operation.branchName ||
      !operation.blueprintName ||
      !operation.blueprintDigest ||
      !operation.blueprintSnapshot
    ) {
      throw new IncusError('Capsule create operation is missing durable execution input.', 'API_ERROR', {
        operationId,
        hasBranchId: operation.branchId !== null,
        hasBranchName: operation.branchName !== null,
        hasBlueprintName: operation.blueprintName !== null,
        hasBlueprintDigest: operation.blueprintDigest !== null,
        hasBlueprintSnapshot: operation.blueprintSnapshot !== null,
      })
    }

    const [branch] = await this.db
      .select({
        id: capsuleBranchesTable.id,
        capsuleId: capsuleBranchesTable.capsuleId,
        ownerId: capsuleBranchesTable.ownerId,
        name: capsuleBranchesTable.name,
        status: capsuleBranchesTable.status,
        isRootBranch: capsuleBranchesTable.isRootBranch,
        blueprintName: capsuleBranchesTable.blueprintName,
        blueprintDigest: capsuleBranchesTable.blueprintDigest,
        cpu: capsuleBranchesTable.cpu,
        memory: capsuleBranchesTable.memory,
      })
      .from(capsuleBranchesTable)
      .where(eq(capsuleBranchesTable.id, operation.branchId))
      .limit(1)

    if (
      !branch ||
      branch.ownerId !== operation.ownerId ||
      branch.capsuleId !== operation.capsuleId ||
      branch.name !== operation.branchName ||
      branch.status !== 'provisioning' ||
      !branch.isRootBranch ||
      branch.blueprintName !== operation.blueprintName ||
      branch.blueprintDigest !== operation.blueprintDigest
    ) {
      throw new IncusError('Capsule create root branch identity does not match its accepted operation.', 'CONFLICT', {
        operationId,
        branchId: operation.branchId,
      })
    }

    return {
      operationId: operation.id,
      capsuleId: operation.capsuleId,
      ownerId: operation.ownerId,
      rootBranchId: branch.id,
      rootBranchName: branch.name,
      blueprintName: operation.blueprintName,
      blueprintDigest: CapsuleBlueprintDigestSchema.parse(operation.blueprintDigest),
      blueprintSnapshot: operation.blueprintSnapshot,
      cpu: branch.cpu,
      memory: branch.memory,
    }
  }

  /**
   * Claims one accepted create operation for process-local execution.
   */
  public async claimForExecution(operationId: string) {
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
          eq(capsuleOperationsTable.type, CapsuleOperationType.CREATE),
          eq(capsuleOperationsTable.status, CapsuleOperationStatus.ACCEPTED),
          isNull(capsuleOperationsTable.providerMutationStartedAt),
        ),
      )
      .returning({
        ownerId: capsuleOperationsTable.ownerId,
        capsuleId: capsuleOperationsTable.capsuleId,
        branchId: capsuleOperationsTable.branchId,
      })

    if (!claimed) {
      throw new IncusError('Capsule create operation could not be claimed from accepted to running.', 'CONFLICT', {
        operationId,
      })
    }

    return toCapsuleOperationTransition({
      ownerId: claimed.ownerId,
      operationId,
      capsuleId: claimed.capsuleId,
      branchId: claimed.branchId,
      operationType: CapsuleOperationType.CREATE,
      operationStatus: CapsuleOperationStatus.RUNNING,
    })
  }

  /**
   * Persists the immutable proof of the complete branch resource plan before
   * provider intent is committed.
   */
  public async recordResourceInventoryProof(
    ownerId: string,
    operationId: string,
    rootBranchId: string,
    digest: CapsuleBranchResourceInventoryDigest,
  ): Promise<void> {
    const updatedBranches = await this.db
      .update(capsuleBranchesTable)
      .set({
        resourceInventoryDigest: digest,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(capsuleBranchesTable.id, rootBranchId),
          eq(capsuleBranchesTable.ownerId, ownerId),
          eq(capsuleBranchesTable.status, 'provisioning'),
          eq(capsuleBranchesTable.isRootBranch, true),
          isNull(capsuleBranchesTable.resourceInventoryDigest),
        ),
      )
      .returning({
        id: capsuleBranchesTable.id,
      })

    if (updatedBranches.length !== 1) {
      throw new IncusError('Failed to persist the root branch resource inventory proof.', 'CONFLICT', {
        ownerId,
        operationId,
        rootBranchId,
      })
    }
  }

  /**
   * Commits the operation-wide provider-intent fence.
   *
   * This write must complete before any Incus state-changing call.
   */
  public async commitProviderIntentFence(operationId: string): Promise<void> {
    const now = new Date()

    const updatedOperations = await this.db
      .update(capsuleOperationsTable)
      .set({
        providerMutationStartedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(capsuleOperationsTable.id, operationId),
          eq(capsuleOperationsTable.type, CapsuleOperationType.CREATE),
          eq(capsuleOperationsTable.status, CapsuleOperationStatus.RUNNING),
          isNull(capsuleOperationsTable.providerMutationStartedAt),
        ),
      )
      .returning({
        id: capsuleOperationsTable.id,
      })

    if (updatedOperations.length !== 1) {
      throw new IncusError('Failed to commit the capsule create provider-intent fence.', 'CONFLICT', {
        operationId,
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Successful completion
  // ---------------------------------------------------------------------------

  /**
   * Atomically commits successful capsule creation.
   */
  public async completeCreate(operationId: string): Promise<CreateCapsuleTerminalResult> {
    return await this.db.transaction(async tx => {
      const operation = await this.lockCreateOperation(tx, operationId)

      if (operation.status !== CapsuleOperationStatus.RUNNING || operation.providerMutationStartedAt === null || operation.branchId === null) {
        throw new IncusError('Capsule create operation is not eligible for successful completion.', 'CONFLICT', {
          operationId,
          operationStatus: operation.status,
          hasProviderIntent: operation.providerMutationStartedAt !== null,
          branchId: operation.branchId,
        })
      }

      const capsule = await this.lockCapsule(tx, operation.ownerId, operation.capsuleId)
      const branch = await this.lockRootBranch(tx, operation.ownerId, operation.capsuleId, operation.branchId)

      if (
        capsule.lifecycleStatus !== 'provisioning' ||
        capsule.archivedAt !== null ||
        branch.status !== 'provisioning' ||
        operation.branchName !== branch.name
      ) {
        throw new IncusError('Capsule create aggregate is not eligible for completion.', 'CONFLICT', {
          operationId,
          capsuleStatus: capsule.lifecycleStatus,
          branchStatus: branch.status,
          operationBranchName: operation.branchName,
          rootBranchName: branch.name,
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
            eq(capsuleOperationsTable.type, CapsuleOperationType.CREATE),
            eq(capsuleOperationsTable.status, CapsuleOperationStatus.RUNNING),
          ),
        )
        .returning({
          id: capsuleOperationsTable.id,
        })

      const [activeCapsule] = await tx
        .update(capsulesTable)
        .set({
          lifecycleStatus: 'active',
          updatedAt: now,
        })
        .where(
          and(
            eq(capsulesTable.id, operation.capsuleId),
            eq(capsulesTable.ownerId, operation.ownerId),
            eq(capsulesTable.lifecycleStatus, 'provisioning'),
          ),
        )
        .returning({
          lifecycleStatus: capsulesTable.lifecycleStatus,
          archivedAt: capsulesTable.archivedAt,
          destroyedAt: capsulesTable.destroyedAt,
        })

      const [offlineBranch] = await tx
        .update(capsuleBranchesTable)
        .set({
          status: 'offline',
          runtimeIp: null,
          runtimeErrorCode: null,
          runtimeErrorMessage: null,
          runtimeErrorDetails: null,
          runtimeErrorAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleBranchesTable.id, branch.id),
            eq(capsuleBranchesTable.ownerId, operation.ownerId),
            eq(capsuleBranchesTable.capsuleId, operation.capsuleId),
            eq(capsuleBranchesTable.status, 'provisioning'),
          ),
        )
        .returning({
          id: capsuleBranchesTable.id,
          capsuleId: capsuleBranchesTable.capsuleId,
          name: capsuleBranchesTable.name,
          status: capsuleBranchesTable.status,
        })

      if (!completedOperation || !activeCapsule || !offlineBranch) {
        throw new IncusError('Failed to atomically finalize capsule creation.', 'CONFLICT', {
          operationId,
        })
      }

      return {
        operation: toCapsuleOperationTransition({
          ownerId: operation.ownerId,
          operationId,
          capsuleId: operation.capsuleId,
          branchId: branch.id,
          operationType: CapsuleOperationType.CREATE,
          operationStatus: CapsuleOperationStatus.COMPLETED,
        }),
        capsule: CapsuleLifecycleStateSchema.parse({
          capsuleId: operation.capsuleId,
          lifecycleStatus: activeCapsule.lifecycleStatus,
          archivedAt: toNullableIsoTimestamp(activeCapsule.archivedAt, 'archivedAt', {
            entity: 'capsule',
            entityId: operation.capsuleId,
          }),
          destroyedAt: toNullableIsoTimestamp(activeCapsule.destroyedAt, 'destroyedAt', {
            entity: 'capsule',
            entityId: operation.capsuleId,
          }),
        }),
        branch: offlineBranch,
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Safe pre-provider failure
  // ---------------------------------------------------------------------------

  /**
   * Terminalizes a create failure proven to have occurred before provider
   * mutation.
   *
   * Both accepted and running operations are eligible. The transaction
   * independently validates all durable evidence rather than trusting
   * process-local execution state.
   *
   * An inventory digest is allowed because create records the complete plan
   * before provider intent. Branch resource rows are not allowed before that
   * fence; their presence makes provider ownership ambiguous and forces
   * cleanup-required classification.
   */
  public async failBeforeProviderMutation(
    operationId: string,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<CreateCapsuleTerminalResult> {
    return await this.db.transaction(async tx => {
      const operation = await this.lockCreateOperation(tx, operationId)

      if (!isNonterminalCreateStatus(operation.status)) {
        throw new IncusError('Capsule create operation is already terminal.', 'CONFLICT', {
          operationId,
          operationStatus: operation.status,
        })
      }

      const capsule = await this.lockCapsule(tx, operation.ownerId, operation.capsuleId)
      const rootBranches = await this.lockRootBranchesForClassification(tx, operation.ownerId, operation.capsuleId)
      const rootBranch = rootBranches.length === 1 ? rootBranches[0]! : null
      const resourceEvidence = await this.lockPreProviderResourceEvidence(tx, operation.id, rootBranch?.id ?? null)

      const contradictions = this.collectPreProviderContradictions(operation, capsule, rootBranches, resourceEvidence)

      if (contradictions.length > 0) {
        return await this.markCleanupRequiredInTransaction(tx, operation, capsule, rootBranch, error, {
          ...context,
          classification: 'pre_provider_create_failure',
          safePreProviderFailure: false,
          contradictions,
          resourceEvidence: resourceEvidence.map(resource => ({
            resourceId: resource.id,
            branchId: resource.branchId,
            resourceKey: resource.resourceKey,
            resourceType: resource.resourceType,
            status: resource.status,
            createdByOperationId: resource.createdByOperationId,
            lastOperationId: resource.lastOperationId,
          })),
        })
      }

      if (!rootBranch) {
        throw new IncusError('Safe pre-provider create failure requires exactly one durable root branch.', 'CONFLICT', {
          operationId,
          capsuleId: operation.capsuleId,
        })
      }

      const failureDetails = createFailureDetails(error, {
        ...context,
        classification: 'pre_provider_create_failure',
        safePreProviderFailure: true,
        providerIntentCommitted: false,
        resourceEvidenceCount: 0,
      })
      const now = new Date()

      const [failedOperation] = await tx
        .update(capsuleOperationsTable)
        .set({
          status: CapsuleOperationStatus.FAILED,
          failedAt: now,
          failureCode: failureCodeFromUnknown(error),
          failureMessage: failureMessageFromUnknown(error, 'Capsule creation failed before provider mutation.'),
          failureDetails:
            failureDetails === undefined ? undefined : toJsonObject(failureDetails, 'capsule create pre-provider failure details'),
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleOperationsTable.id, operationId),
            eq(capsuleOperationsTable.type, CapsuleOperationType.CREATE),
            inArray(capsuleOperationsTable.status, NONTERMINAL_CREATE_STATUSES),
            isNull(capsuleOperationsTable.providerMutationStartedAt),
          ),
        )
        .returning({
          id: capsuleOperationsTable.id,
        })

      const [failedCapsule] = await tx
        .update(capsulesTable)
        .set({
          lifecycleStatus: 'creation_failed',
          updatedAt: now,
        })
        .where(
          and(
            eq(capsulesTable.id, operation.capsuleId),
            eq(capsulesTable.ownerId, operation.ownerId),
            eq(capsulesTable.lifecycleStatus, 'provisioning'),
          ),
        )
        .returning({
          lifecycleStatus: capsulesTable.lifecycleStatus,
          archivedAt: capsulesTable.archivedAt,
          destroyedAt: capsulesTable.destroyedAt,
        })

      const [retiredBranch] = await tx
        .update(capsuleBranchesTable)
        .set({
          status: 'destroyed',
          runtimeIp: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleBranchesTable.id, rootBranch.id),
            eq(capsuleBranchesTable.ownerId, operation.ownerId),
            eq(capsuleBranchesTable.capsuleId, operation.capsuleId),
            eq(capsuleBranchesTable.status, 'provisioning'),
            eq(capsuleBranchesTable.isRootBranch, true),
          ),
        )
        .returning({
          id: capsuleBranchesTable.id,
          capsuleId: capsuleBranchesTable.capsuleId,
          name: capsuleBranchesTable.name,
          status: capsuleBranchesTable.status,
        })

      if (!failedOperation || !failedCapsule || !retiredBranch) {
        throw new IncusError('Failed to atomically finalize the pre-provider capsule create failure.', 'CONFLICT', {
          operationId,
          capsuleId: operation.capsuleId,
          rootBranchId: rootBranch.id,
        })
      }

      return {
        operation: toCapsuleOperationTransition({
          ownerId: operation.ownerId,
          operationId,
          capsuleId: operation.capsuleId,
          branchId: rootBranch.id,
          operationType: CapsuleOperationType.CREATE,
          operationStatus: CapsuleOperationStatus.FAILED,
        }),
        capsule: CapsuleLifecycleStateSchema.parse({
          capsuleId: operation.capsuleId,
          lifecycleStatus: failedCapsule.lifecycleStatus,
          archivedAt: toNullableIsoTimestamp(failedCapsule.archivedAt, 'archivedAt', {
            entity: 'capsule',
            entityId: operation.capsuleId,
          }),
          destroyedAt: toNullableIsoTimestamp(failedCapsule.destroyedAt, 'destroyedAt', {
            entity: 'capsule',
            entityId: operation.capsuleId,
          }),
        }),
        branch: retiredBranch,
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Post-provider terminalization
  // ---------------------------------------------------------------------------

  /**
   * Finalizes a failed create after every proven same-process provider creation
   * was successfully compensated.
   */
  public async failAfterSuccessfulCompensation(
    operationId: string,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<CreateCapsuleTerminalResult> {
    const details = createFailureDetails(error, context)

    return await this.db.transaction(async tx => {
      const operation = await this.lockCreateOperation(tx, operationId)

      if (operation.status !== CapsuleOperationStatus.RUNNING || operation.branchId === null || operation.providerMutationStartedAt === null) {
        throw new IncusError('Capsule create operation is not eligible for compensated failure.', 'CONFLICT', {
          operationId,
          operationStatus: operation.status,
          branchId: operation.branchId,
          providerIntentCommitted: operation.providerMutationStartedAt !== null,
        })
      }

      const capsule = await this.lockCapsule(tx, operation.ownerId, operation.capsuleId)
      const branch = await this.lockRootBranch(tx, operation.ownerId, operation.capsuleId, operation.branchId)

      if (capsule.lifecycleStatus !== 'provisioning' || branch.status !== 'provisioning' || operation.branchName !== branch.name) {
        throw new IncusError('Capsule create aggregate cannot be classified as a compensated failure.', 'CONFLICT', {
          operationId,
          capsuleStatus: capsule.lifecycleStatus,
          branchStatus: branch.status,
          operationBranchName: operation.branchName,
          rootBranchName: branch.name,
        })
      }

      const now = new Date()

      const [failedOperation] = await tx
        .update(capsuleOperationsTable)
        .set({
          status: CapsuleOperationStatus.FAILED,
          failedAt: now,
          failureCode: failureCodeFromUnknown(error),
          failureMessage: failureMessageFromUnknown(error, 'Capsule creation failed after provider compensation.'),
          failureDetails: details === undefined ? undefined : toJsonObject(details, 'capsule create compensated failure details'),
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleOperationsTable.id, operationId),
            eq(capsuleOperationsTable.type, CapsuleOperationType.CREATE),
            eq(capsuleOperationsTable.status, CapsuleOperationStatus.RUNNING),
          ),
        )
        .returning({
          id: capsuleOperationsTable.id,
        })

      const [failedCapsule] = await tx
        .update(capsulesTable)
        .set({
          lifecycleStatus: 'creation_failed',
          updatedAt: now,
        })
        .where(
          and(
            eq(capsulesTable.id, operation.capsuleId),
            eq(capsulesTable.ownerId, operation.ownerId),
            eq(capsulesTable.lifecycleStatus, 'provisioning'),
          ),
        )
        .returning({
          lifecycleStatus: capsulesTable.lifecycleStatus,
          archivedAt: capsulesTable.archivedAt,
          destroyedAt: capsulesTable.destroyedAt,
        })

      // Preserve the durable root ID required by create receipt replay.
      const [retiredBranch] = await tx
        .update(capsuleBranchesTable)
        .set({
          status: 'destroyed',
          runtimeIp: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleBranchesTable.id, branch.id),
            eq(capsuleBranchesTable.ownerId, operation.ownerId),
            eq(capsuleBranchesTable.capsuleId, operation.capsuleId),
            eq(capsuleBranchesTable.status, 'provisioning'),
          ),
        )
        .returning({
          id: capsuleBranchesTable.id,
          capsuleId: capsuleBranchesTable.capsuleId,
          name: capsuleBranchesTable.name,
          status: capsuleBranchesTable.status,
        })

      if (!failedOperation || !failedCapsule || !retiredBranch) {
        throw new IncusError('Failed to atomically finalize the compensated capsule create failure.', 'CONFLICT', {
          operationId,
        })
      }

      return {
        operation: toCapsuleOperationTransition({
          ownerId: operation.ownerId,
          operationId,
          capsuleId: operation.capsuleId,
          branchId: branch.id,
          operationType: CapsuleOperationType.CREATE,
          operationStatus: CapsuleOperationStatus.FAILED,
        }),
        capsule: CapsuleLifecycleStateSchema.parse({
          capsuleId: operation.capsuleId,
          lifecycleStatus: failedCapsule.lifecycleStatus,
          archivedAt: toNullableIsoTimestamp(failedCapsule.archivedAt, 'archivedAt', {
            entity: 'capsule',
            entityId: operation.capsuleId,
          }),
          destroyedAt: toNullableIsoTimestamp(failedCapsule.destroyedAt, 'destroyedAt', {
            entity: 'capsule',
            entityId: operation.capsuleId,
          }),
        }),
        branch: retiredBranch,
      }
    })
  }

  /**
   * Marks a nonterminal create operation and its aggregate cleanup-required.
   */
  public async markCleanupRequired(
    operationId: string,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<CreateCapsuleTerminalResult> {
    return await this.db.transaction(async tx => {
      const operation = await this.lockCreateOperation(tx, operationId)

      if (!isNonterminalCreateStatus(operation.status)) {
        throw new IncusError('Capsule create operation is already terminal.', 'CONFLICT', {
          operationId,
          operationStatus: operation.status,
        })
      }

      const capsule = await this.lockCapsule(tx, operation.ownerId, operation.capsuleId)
      const branch =
        operation.branchId === null ? null : await this.lockRootBranch(tx, operation.ownerId, operation.capsuleId, operation.branchId)

      return await this.markCleanupRequiredInTransaction(tx, operation, capsule, branch, error, context)
    })
  }

  // ---------------------------------------------------------------------------
  // Abandoned-operation classification
  // ---------------------------------------------------------------------------

  /**
   * Classifies a nonterminal create operation left by an earlier Worker.
   *
   * No executor is invoked and no provider state is inspected. Accepted or
   * running operations without provider intent use the same pre-provider
   * terminalization transaction as live executor failures.
   */
  public async classifyAbandoned(operationId: string): Promise<CreateCapsuleTerminalResult | null> {
    const operation = await this.reader.loadById(operationId)

    if (!operation || operation.type !== CapsuleOperationType.CREATE || !isNonterminalCreateStatus(operation.status)) {
      return null
    }

    const error = new IncusError('Capsule create operation was abandoned by a previous Worker process.', 'API_ERROR', {
      operationId,
      providerMutationStartedAt: operation.providerMutationStartedAt,
      policy: 'no_provider_mutation_after_restart',
    })

    if (operation.providerMutationStartedAt !== null) {
      return await this.markCleanupRequired(operationId, error, {
        operationId,
        phase: 'startup_abandoned_operation_classification',
        providerIntentCommitted: true,
        providerOwnershipUncertain: true,
      })
    }

    return await this.failBeforeProviderMutation(operationId, error, {
      operationId,
      phase: 'startup_abandoned_operation_classification',
      providerIntentCommitted: false,
      compensationAttempted: false,
      policy: 'safe_pre_provider_failure',
    })
  }

  // ---------------------------------------------------------------------------
  // Private terminalization mechanics
  // ---------------------------------------------------------------------------

  private async markCleanupRequiredInTransaction(
    tx: CreateTransaction,
    operation: PersistedCreateOperation,
    capsule: PersistedCapsule,
    branch: PersistedCapsuleBranch | null,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<CreateCapsuleTerminalResult> {
    if (!isNonterminalCreateStatus(operation.status)) {
      throw new IncusError('Capsule create operation is already terminal.', 'CONFLICT', {
        operationId: operation.id,
        operationStatus: operation.status,
      })
    }

    const details = createFailureDetails(error, context)
    const now = new Date()

    const [cleanupOperation] = await tx
      .update(capsuleOperationsTable)
      .set({
        status: CapsuleOperationStatus.CLEANUP_REQUIRED,
        failedAt: now,
        failureCode: failureCodeFromUnknown(error),
        failureMessage: failureMessageFromUnknown(error, 'Capsule creation requires manual cleanup.'),
        failureDetails: details === undefined ? undefined : toJsonObject(details, 'capsule create cleanup-required details'),
        updatedAt: now,
      })
      .where(
        and(
          eq(capsuleOperationsTable.id, operation.id),
          eq(capsuleOperationsTable.type, CapsuleOperationType.CREATE),
          inArray(capsuleOperationsTable.status, NONTERMINAL_CREATE_STATUSES),
        ),
      )
      .returning({
        id: capsuleOperationsTable.id,
      })

    const [cleanupCapsule] = await tx
      .update(capsulesTable)
      .set({
        lifecycleStatus: 'cleanup_required',
        updatedAt: now,
      })
      .where(and(eq(capsulesTable.id, capsule.id), eq(capsulesTable.ownerId, operation.ownerId)))
      .returning({
        lifecycleStatus: capsulesTable.lifecycleStatus,
        archivedAt: capsulesTable.archivedAt,
        destroyedAt: capsulesTable.destroyedAt,
      })

    let cleanupBranch: CreateCapsuleCommittedBranch | null = null

    if (branch && branch.status !== 'destroyed') {
      const [updatedBranch] = await tx
        .update(capsuleBranchesTable)
        .set({
          status: 'cleanup_required',
          runtimeIp: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleBranchesTable.id, branch.id),
            eq(capsuleBranchesTable.ownerId, operation.ownerId),
            eq(capsuleBranchesTable.capsuleId, operation.capsuleId),
          ),
        )
        .returning({
          id: capsuleBranchesTable.id,
          capsuleId: capsuleBranchesTable.capsuleId,
          name: capsuleBranchesTable.name,
          status: capsuleBranchesTable.status,
        })

      cleanupBranch = updatedBranch ?? null
    } else if (branch) {
      cleanupBranch = {
        id: branch.id,
        capsuleId: operation.capsuleId,
        name: branch.name,
        status: branch.status,
      }
    }

    if (!cleanupOperation || !cleanupCapsule) {
      throw new IncusError('Failed to atomically classify capsule creation as cleanup required.', 'CONFLICT', {
        operationId: operation.id,
      })
    }

    return {
      operation: toCapsuleOperationTransition({
        ownerId: operation.ownerId,
        operationId: operation.id,
        capsuleId: operation.capsuleId,
        branchId: branch?.id ?? operation.branchId,
        operationType: CapsuleOperationType.CREATE,
        operationStatus: CapsuleOperationStatus.CLEANUP_REQUIRED,
      }),
      capsule: CapsuleLifecycleStateSchema.parse({
        capsuleId: operation.capsuleId,
        lifecycleStatus: cleanupCapsule.lifecycleStatus,
        archivedAt: toNullableIsoTimestamp(cleanupCapsule.archivedAt, 'archivedAt', {
          entity: 'capsule',
          entityId: operation.capsuleId,
        }),
        destroyedAt: toNullableIsoTimestamp(cleanupCapsule.destroyedAt, 'destroyedAt', {
          entity: 'capsule',
          entityId: operation.capsuleId,
        }),
      }),
      branch: cleanupBranch,
    }
  }

  // ---------------------------------------------------------------------------
  // Private replay and result mapping
  // ---------------------------------------------------------------------------

  private async loadCreateResult(
    operation: PersistedCapsuleOperation,
    newlyAccepted: boolean,
    replayed: boolean,
  ): Promise<CreateCapsuleRepositoryResult> {
    if (!operation.branchId || !operation.branchName) {
      throw new IncusError('Capsule create operation cannot produce a receipt without its durable root branch.', 'API_ERROR', {
        operationId: operation.id,
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

    const [branch] = await this.db
      .select({
        id: capsuleBranchesTable.id,
        capsuleId: capsuleBranchesTable.capsuleId,
        name: capsuleBranchesTable.name,
        status: capsuleBranchesTable.status,
      })
      .from(capsuleBranchesTable)
      .where(
        and(
          eq(capsuleBranchesTable.id, operation.branchId),
          eq(capsuleBranchesTable.ownerId, operation.ownerId),
          eq(capsuleBranchesTable.capsuleId, operation.capsuleId),
        ),
      )
      .limit(1)

    if (!capsule || !branch) {
      throw new IncusError('Capsule create operation references missing durable aggregate state.', 'API_ERROR', {
        operationId: operation.id,
        capsuleId: operation.capsuleId,
        rootBranchId: operation.branchId,
      })
    }

    return {
      newlyAccepted,
      receipt: this.createCreateReceipt({
        operationId: operation.id,
        capsuleId: operation.capsuleId,
        rootBranchId: branch.id,
        rootBranchName: branch.name,
        operationStatus: operation.status,
        replayed,
      }),
      operation: toCapsuleOperationTransition({
        ownerId: operation.ownerId,
        operationId: operation.id,
        capsuleId: operation.capsuleId,
        branchId: branch.id,
        operationType: CapsuleOperationType.CREATE,
        operationStatus: operation.status,
      }),
      capsule: CapsuleLifecycleStateSchema.parse({
        capsuleId: operation.capsuleId,
        lifecycleStatus: capsule.lifecycleStatus,
        archivedAt: toNullableIsoTimestamp(capsule.archivedAt, 'archivedAt', {
          entity: 'capsule',
          entityId: operation.capsuleId,
        }),
        destroyedAt: toNullableIsoTimestamp(capsule.destroyedAt, 'destroyedAt', {
          entity: 'capsule',
          entityId: operation.capsuleId,
        }),
      }),
      branch,
    }
  }

  private assertIdempotentReplay(operation: PersistedCapsuleOperation, requestHash: CapsuleOperationRequestHash): void {
    assertOperationReplayIdentity(operation, {
      operationType: CapsuleOperationType.CREATE,
      requestHash,
      requestDescription: 'capsule create',
    })
  }

  private createCreateReceipt(input: {
    operationId: string
    capsuleId: string
    rootBranchId: string
    rootBranchName: string
    operationStatus: PersistedCapsuleOperation['status']
    replayed: boolean
  }): CapsuleCreateReceipt {
    return CapsuleCreateReceiptSchema.parse({
      operationId: input.operationId,
      operationType: CapsuleOperationType.CREATE,
      operationStatus: input.operationStatus,
      capsuleId: input.capsuleId,
      rootBranchId: input.rootBranchId,
      rootBranchName: input.rootBranchName,
      replayed: input.replayed,
    })
  }

  // ---------------------------------------------------------------------------
  // Private pre-provider safety proof
  // ---------------------------------------------------------------------------

  private collectPreProviderContradictions(
    operation: PersistedCreateOperation,
    capsule: PersistedCapsule,
    rootBranches: readonly PersistedCapsuleBranch[],
    resourceEvidence: readonly PreProviderResourceEvidence[],
  ): string[] {
    const contradictions: string[] = []

    if (operation.providerMutationStartedAt !== null) {
      contradictions.push('provider_intent_present')
    }

    if (capsule.lifecycleStatus !== 'provisioning') {
      contradictions.push('capsule_not_provisioning')
    }

    if (capsule.archivedAt !== null) {
      contradictions.push('capsule_unexpectedly_archived')
    }

    if (rootBranches.length !== 1) {
      contradictions.push('root_branch_count_invalid')
    }

    const rootBranch = rootBranches.length === 1 ? rootBranches[0]! : null

    if (rootBranch) {
      if (operation.branchId !== rootBranch.id) {
        contradictions.push('operation_root_branch_link_mismatch')
      }

      if (operation.branchName !== rootBranch.name) {
        contradictions.push('operation_root_branch_name_mismatch')
      }

      if (rootBranch.status !== 'provisioning') {
        contradictions.push('root_branch_not_provisioning')
      }

      if (rootBranch.ownerId !== operation.ownerId || rootBranch.capsuleId !== operation.capsuleId) {
        contradictions.push('root_branch_aggregate_identity_mismatch')
      }
    }

    if (resourceEvidence.length > 0) {
      contradictions.push('branch_resource_evidence_present_before_provider_intent')
    }

    return contradictions
  }

  private async lockPreProviderResourceEvidence(
    tx: CreateTransaction,
    operationId: string,
    rootBranchId: string | null,
  ): Promise<PreProviderResourceEvidence[]> {
    const evidencePredicate =
      rootBranchId === null
        ? eq(capsuleBranchResourcesTable.createdByOperationId, operationId)
        : or(eq(capsuleBranchResourcesTable.createdByOperationId, operationId), eq(capsuleBranchResourcesTable.branchId, rootBranchId))

    return await tx
      .select({
        id: capsuleBranchResourcesTable.id,
        branchId: capsuleBranchResourcesTable.branchId,
        resourceKey: capsuleBranchResourcesTable.resourceKey,
        resourceType: capsuleBranchResourcesTable.resourceType,
        status: capsuleBranchResourcesTable.status,
        createdByOperationId: capsuleBranchResourcesTable.createdByOperationId,
        lastOperationId: capsuleBranchResourcesTable.lastOperationId,
      })
      .from(capsuleBranchResourcesTable)
      .where(evidencePredicate)
      .orderBy(asc(capsuleBranchResourcesTable.id))
      .for('update')
  }

  // ---------------------------------------------------------------------------
  // Private locking helpers
  // ---------------------------------------------------------------------------

  private async lockRootBranchesForClassification(
    tx: CreateTransaction,
    ownerId: string,
    capsuleId: string,
  ): Promise<PersistedCapsuleBranch[]> {
    return await tx
      .select()
      .from(capsuleBranchesTable)
      .where(
        and(
          eq(capsuleBranchesTable.ownerId, ownerId),
          eq(capsuleBranchesTable.capsuleId, capsuleId),
          eq(capsuleBranchesTable.isRootBranch, true),
        ),
      )
      .orderBy(asc(capsuleBranchesTable.id))
      .for('update')
  }

  private async lockCreateOperation(tx: CreateTransaction, operationId: string): Promise<PersistedCreateOperation> {
    const [operation] = await tx
      .select()
      .from(capsuleOperationsTable)
      .where(and(eq(capsuleOperationsTable.id, operationId), eq(capsuleOperationsTable.type, CapsuleOperationType.CREATE)))
      .for('update')
      .limit(1)

    if (!operation) {
      throw new IncusError('Capsule create operation was not found.', 'NOT_FOUND', {
        operationId,
      })
    }

    return operation
  }

  private async lockCapsule(tx: CreateTransaction, ownerId: string, capsuleId: string): Promise<PersistedCapsule> {
    const [capsule] = await tx
      .select()
      .from(capsulesTable)
      .where(and(eq(capsulesTable.id, capsuleId), eq(capsulesTable.ownerId, ownerId)))
      .for('update')
      .limit(1)

    if (!capsule) {
      throw new IncusError('Capsule aggregate was not found.', 'NOT_FOUND', {
        ownerId,
        capsuleId,
      })
    }

    return capsule
  }

  private async lockRootBranch(tx: CreateTransaction, ownerId: string, capsuleId: string, branchId: string): Promise<PersistedCapsuleBranch> {
    const [branch] = await tx
      .select()
      .from(capsuleBranchesTable)
      .where(
        and(
          eq(capsuleBranchesTable.id, branchId),
          eq(capsuleBranchesTable.ownerId, ownerId),
          eq(capsuleBranchesTable.capsuleId, capsuleId),
          eq(capsuleBranchesTable.isRootBranch, true),
        ),
      )
      .for('update')
      .limit(1)

    if (!branch) {
      throw new IncusError('Capsule root branch was not found.', 'NOT_FOUND', {
        ownerId,
        capsuleId,
        branchId,
      })
    }

    return branch
  }
}
