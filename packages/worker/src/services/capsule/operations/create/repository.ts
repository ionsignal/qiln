import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm'
import {
  CapsuleBlueprintDigestSchema,
  CapsuleBlueprintSchema,
  CapsuleCreateReceiptSchema,
  CapsuleLifecycleStateSchema,
  CapsuleOperationStatus,
  CapsuleOperationType,
  digestCanonicalJsonValue,
  type CapsuleActorReference,
  type CapsuleBlueprint,
  type CapsuleBlueprintDigest,
  type CapsuleBranchResourceInventoryDigest,
  type CapsuleCreateReceipt,
  type CapsuleOperationRequestHash,
  type CapsuleOperationStatusValue,
  type CapsulePersistence,
  type CapsuleRootfsImagePin,
  type CapsuleTables,
} from '@qiln/core/server'
import { IncusError, isUniqueConstraintViolation } from '../../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from '../../failures'
import {
  readRootfs,
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
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

const NONTERMINAL_CREATE_STATUSES = [CapsuleOperationStatus.ACCEPTED, CapsuleOperationStatus.RUNNING] as const

type PersistedCreateOperation = CapsuleTables['capsuleOperations']['$inferSelect']
type PersistedCreateOperationExtension = CapsuleTables['capsuleCreateOperations']['$inferSelect']
type PersistedCapsule = CapsuleTables['capsules']['$inferSelect']
type PersistedCapsuleBranch = CapsuleTables['capsuleBranches']['$inferSelect']

interface PreProviderResourceEvidence {
  id: string
  branchId: string | null
  resourceKey: string
  resourceType: string
  status: string
  createdByOperationId: string | null
  lastOperationId: string | null
}

interface ValidatedCreateOperationDetails {
  extension: PersistedCreateOperationExtension
  rootBranch: PersistedCapsuleBranch
  blueprintDigest: CapsuleBlueprintDigest
  blueprintSnapshot: CapsuleBlueprint
  rootfsImagePin: CapsuleRootfsImagePin
}

function isNonterminalCreateStatus(
  status: CapsuleOperationStatusValue,
): status is (typeof NONTERMINAL_CREATE_STATUSES)[number] {
  return status === CapsuleOperationStatus.ACCEPTED || status === CapsuleOperationStatus.RUNNING
}

/**
 * Owns every create-specific operation and aggregate transaction.
 *
 * The shared operation ledger contains only fields meaningful across every
 * operation type. Immutable create input and the committed root-branch
 * reference live in `capsule_create_operations`.
 *
 * This repository is the authoritative persistence boundary for create
 * acceptance, extension validation, immutable execution input, mutation fences,
 * terminal aggregate transitions, and abandoned-create classification.
 */
export class CreateCapsuleOperationRepository<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly reader: CapsuleOperationReader<TDatabase, TTables>,
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
   *
   * Actor identity is checked independently from the request hash. This ensures
   * another authenticated principal cannot replay an owner's idempotency key,
   * even if the request-hash construction is changed incorrectly later.
   */
  public async findIdempotentReplay(
    ownerId: string,
    actor: CapsuleActorReference,
    idempotencyKey: string,
    requestHash: CapsuleOperationRequestHash,
  ): Promise<CreateCapsuleRepositoryResult | null> {
    const operation = await this.reader.loadByOwnerAndIdempotencyKey(ownerId, idempotencyKey)

    if (!operation) {
      return null
    }

    this.assertIdempotentReplay(operation, actor, requestHash)

    return await this.loadCreateResult(operation, false, true)
  }

  /**
   * Atomically accepts a create operation, creates its capsule aggregate and
   * root branch, and records its immutable create extension.
   *
   * Actor provenance, the base operation, immutable create input, capsule, and
   * provisional root branch are committed in one transaction.
   */
  public async acceptCreate(input: AcceptCreateCapsuleOperationInput): Promise<CreateCapsuleRepositoryResult> {
    const replay = await this.findIdempotentReplay(input.ownerId, input.actor, input.idempotencyKey, input.requestHash)
    if (replay) {
      return replay
    }
    const rootfsImagePin = readRootfs(input.rootfsImagePin, input.blueprintSnapshot.image_alias, {
      ownerId: input.ownerId,
      rootBranchName: input.rootBranchName,
      blueprintName: input.blueprintName,
      blueprintDigest: input.blueprintDigest,
    })
    const db = this.persistence.db
    const { capsules, capsuleOperations, capsuleBranches, capsuleCreateOperations } = this.persistence.tables
    try {
      return await db.transaction(async tx => {
        const now = new Date()
        const [capsule] = await tx
          .insert(capsules)
          .values({
            ownerId: input.ownerId,
            lifecycleStatus: 'provisioning',
            createdAt: now,
            updatedAt: now,
          })
          .returning({
            id: capsules.id,
            lifecycleStatus: capsules.lifecycleStatus,
            archivedAt: capsules.archivedAt,
            destroyedAt: capsules.destroyedAt,
          })
        if (!capsule) {
          throw new IncusError('Failed to create the durable capsule aggregate.', 'API_ERROR')
        }
        const [operation] = await tx
          .insert(capsuleOperations)
          .values({
            ownerId: input.ownerId,
            actorType: input.actor.type,
            actorId: input.actor.id,
            capsuleId: capsule.id,
            type: CapsuleOperationType.CREATE,
            status: CapsuleOperationStatus.ACCEPTED,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            acceptedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning({
            id: capsuleOperations.id,
            ownerId: capsuleOperations.ownerId,
            capsuleId: capsuleOperations.capsuleId,
            status: capsuleOperations.status,
          })
        if (!operation) {
          throw new IncusError('Failed to accept the durable capsule create operation.', 'API_ERROR')
        }
        const [rootBranch] = await tx
          .insert(capsuleBranches)
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
            id: capsuleBranches.id,
            capsuleId: capsuleBranches.capsuleId,
            name: capsuleBranches.name,
            status: capsuleBranches.status,
          })
        if (!rootBranch) {
          throw new IncusError('Failed to create the provisional capsule root branch.', 'API_ERROR')
        }
        const [createExtension] = await tx
          .insert(capsuleCreateOperations)
          .values({
            operationId: operation.id,
            rootBranchId: rootBranch.id,
            rootBranchName: input.rootBranchName,
            blueprintName: input.blueprintName,
            blueprintDigest: input.blueprintDigest,
            blueprintSnapshot: input.blueprintSnapshot,
            rootfsImagePin,
            cpu: input.cpu,
            memory: input.memory,
          })
          .returning({
            operationId: capsuleCreateOperations.operationId,
            rootBranchId: capsuleCreateOperations.rootBranchId,
          })
        if (
          !createExtension ||
          createExtension.operationId !== operation.id ||
          createExtension.rootBranchId !== rootBranch.id
        ) {
          throw new IncusError('Failed to record immutable capsule create operation input.', 'API_ERROR', {
            operationId: operation.id,
            capsuleId: capsule.id,
            rootBranchId: rootBranch.id,
          })
        }
        return {
          newlyAccepted: true,
          receipt: this.createCreateReceipt({
            operationId: operation.id,
            capsuleId: capsule.id,
            rootBranchId: rootBranch.id,
            rootBranchName: rootBranch.name,
            operationStatus: operation.status,
            replayed: false,
          }),
          operation: toCapsuleOperationTransition({
            ownerId: operation.ownerId,
            operationId: operation.id,
            capsuleId: operation.capsuleId,
            operationType: CapsuleOperationType.CREATE,
            operationStatus: operation.status,
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
          branch: rootBranch,
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
      const racedReplay = await this.findIdempotentReplay(
        input.ownerId,
        input.actor,
        input.idempotencyKey,
        input.requestHash,
      )
      if (racedReplay) {
        return racedReplay
      }
      throw new IncusError(
        `Capsule root branch '${input.rootBranchName}' conflicts with existing durable state.`,
        'CONFLICT',
        {
          ownerId: input.ownerId,
          rootBranchName: input.rootBranchName,
        },
      )
    }
  }

  // ---------------------------------------------------------------------------
  // Immutable execution input and mutation fences
  // ---------------------------------------------------------------------------

  /**
   * Reloads immutable create execution input exclusively from PostgreSQL.
   *
   * The executor receives only the operation ID and cannot retain or reuse the
   * original transport payload. Provider work is authorized only after the base
   * operation, create extension, and root branch agree.
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

    const details = await this.loadValidatedCreateOperationDetails(operation)

    if (details.rootBranch.status !== 'provisioning') {
      throw new IncusError('Capsule create root branch is not in its provisioning state.', 'CONFLICT', {
        operationId,
        rootBranchId: details.rootBranch.id,
        rootBranchStatus: details.rootBranch.status,
      })
    }

    return {
      operationId: operation.id,
      capsuleId: operation.capsuleId,
      ownerId: operation.ownerId,
      rootBranchId: details.extension.rootBranchId,
      rootBranchName: details.extension.rootBranchName,
      blueprintName: details.extension.blueprintName,
      blueprintDigest: details.blueprintDigest,
      blueprintSnapshot: details.blueprintSnapshot,
      rootfsImagePin: details.rootfsImagePin,
      cpu: details.extension.cpu,
      memory: details.extension.memory,
    }
  }

  /**
   * Claims one accepted create operation for process-local execution.
   */
  public async claimForExecution(operationId: string) {
    const db = this.persistence.db
    const capsuleOperations = this.persistence.tables.capsuleOperations
    const now = new Date()
    const [claimed] = await db
      .update(capsuleOperations)
      .set({
        status: CapsuleOperationStatus.RUNNING,
        executionStartedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(capsuleOperations.id, operationId),
          eq(capsuleOperations.type, CapsuleOperationType.CREATE),
          eq(capsuleOperations.status, CapsuleOperationStatus.ACCEPTED),
          isNull(capsuleOperations.providerMutationStartedAt),
        ),
      )
      .returning({
        ownerId: capsuleOperations.ownerId,
        capsuleId: capsuleOperations.capsuleId,
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
    const db = this.persistence.db
    const capsuleBranches = this.persistence.tables.capsuleBranches
    const updatedBranches = await db
      .update(capsuleBranches)
      .set({
        resourceInventoryDigest: digest,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(capsuleBranches.id, rootBranchId),
          eq(capsuleBranches.ownerId, ownerId),
          eq(capsuleBranches.status, 'provisioning'),
          eq(capsuleBranches.isRootBranch, true),
          isNull(capsuleBranches.resourceInventoryDigest),
        ),
      )
      .returning({
        id: capsuleBranches.id,
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
    const db = this.persistence.db
    const capsuleOperations = this.persistence.tables.capsuleOperations
    const now = new Date()
    const updatedOperations = await db
      .update(capsuleOperations)
      .set({
        providerMutationStartedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(capsuleOperations.id, operationId),
          eq(capsuleOperations.type, CapsuleOperationType.CREATE),
          eq(capsuleOperations.status, CapsuleOperationStatus.RUNNING),
          isNull(capsuleOperations.providerMutationStartedAt),
        ),
      )
      .returning({
        id: capsuleOperations.id,
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
   *
   * The transaction locks and validates the create extension before committing
   * terminal aggregate state. Process-local execution input is not accepted as
   * completion authority.
   */
  public async completeCreate(operationId: string): Promise<CreateCapsuleTerminalResult> {
    const db = this.persistence.db
    const { capsuleOperations, capsules, capsuleBranches } = this.persistence.tables
    return await db.transaction(async tx => {
      const operation = await this.lockCreateOperation(tx, operationId)

      if (operation.status !== CapsuleOperationStatus.RUNNING || operation.providerMutationStartedAt === null) {
        throw new IncusError('Capsule create operation is not eligible for successful completion.', 'CONFLICT', {
          operationId,
          operationStatus: operation.status,
          hasProviderIntent: operation.providerMutationStartedAt !== null,
        })
      }

      const extension = await this.lockCreateOperationExtension(tx, operation.id)
      const capsule = await this.lockCapsule(tx, operation.ownerId, operation.capsuleId)
      const rootBranch = await this.lockBranchById(tx, extension.rootBranchId)

      if (
        capsule.lifecycleStatus !== 'provisioning' ||
        capsule.archivedAt !== null ||
        rootBranch.status !== 'provisioning'
      ) {
        throw new IncusError('Capsule create aggregate is not eligible for completion.', 'CONFLICT', {
          operationId,
          capsuleStatus: capsule.lifecycleStatus,
          branchStatus: rootBranch.status,
          rootBranchId: rootBranch.id,
        })
      }
      const now = new Date()
      const [completedOperation] = await tx
        .update(capsuleOperations)
        .set({
          status: CapsuleOperationStatus.COMPLETED,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleOperations.id, operationId),
            eq(capsuleOperations.type, CapsuleOperationType.CREATE),
            eq(capsuleOperations.status, CapsuleOperationStatus.RUNNING),
          ),
        )
        .returning({
          id: capsuleOperations.id,
        })
      const [activeCapsule] = await tx
        .update(capsules)
        .set({
          lifecycleStatus: 'active',
          updatedAt: now,
        })
        .where(
          and(
            eq(capsules.id, operation.capsuleId),
            eq(capsules.ownerId, operation.ownerId),
            eq(capsules.lifecycleStatus, 'provisioning'),
          ),
        )
        .returning({
          lifecycleStatus: capsules.lifecycleStatus,
          archivedAt: capsules.archivedAt,
          destroyedAt: capsules.destroyedAt,
        })
      const [offlineBranch] = await tx
        .update(capsuleBranches)
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
            eq(capsuleBranches.id, rootBranch.id),
            eq(capsuleBranches.ownerId, operation.ownerId),
            eq(capsuleBranches.capsuleId, operation.capsuleId),
            eq(capsuleBranches.status, 'provisioning'),
            eq(capsuleBranches.isRootBranch, true),
          ),
        )
        .returning({
          id: capsuleBranches.id,
          capsuleId: capsuleBranches.capsuleId,
          name: capsuleBranches.name,
          status: capsuleBranches.status,
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
   *
   * Missing or contradictory create-extension evidence also forces
   * cleanup-required classification. Incomplete immutable input cannot
   * authorize an ordinary pre-provider failure path.
   */
  public async failBeforeProviderMutation(
    operationId: string,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<CreateCapsuleTerminalResult> {
    const db = this.persistence.db
    const { capsuleOperations, capsules, capsuleBranches } = this.persistence.tables
    return await db.transaction(async tx => {
      const operation = await this.lockCreateOperation(tx, operationId)
      if (!isNonterminalCreateStatus(operation.status)) {
        throw new IncusError('Capsule create operation is already terminal.', 'CONFLICT', {
          operationId,
          operationStatus: operation.status,
        })
      }
      const extension = await this.lockCreateOperationExtensionIfPresent(tx, operation.id)
      const capsule = await this.lockCapsule(tx, operation.ownerId, operation.capsuleId)
      const rootBranches = await this.lockRootBranchesForClassification(tx, operation.ownerId, operation.capsuleId)
      const rootBranch = this.selectRootBranchForClassification(extension, rootBranches)
      const resourceEvidence = await this.lockPreProviderResourceEvidence(
        tx,
        operation.id,
        extension?.rootBranchId ?? rootBranch?.id ?? null,
      )
      const contradictions = this.collectPreProviderContradictions(
        operation,
        extension,
        capsule,
        rootBranches,
        resourceEvidence,
      )
      if (contradictions.length > 0) {
        return await this.markCleanupRequiredInTransaction(tx, operation, capsule, rootBranch, error, {
          ...context,
          classification: 'pre_provider_create_failure',
          safePreProviderFailure: false,
          contradictions,
          createExtensionPresent: extension !== null,
          createExtensionRootBranchId: extension?.rootBranchId ?? null,
          rootBranchCount: rootBranches.length,
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
      if (!extension || !rootBranch) {
        throw new IncusError(
          'Safe pre-provider create failure requires complete create-extension and root-branch evidence.',
          'CONFLICT',
          {
            operationId,
            capsuleId: operation.capsuleId,
          },
        )
      }
      const failureDetails = createFailureDetails(error, {
        ...context,
        classification: 'pre_provider_create_failure',
        safePreProviderFailure: true,
        providerIntentCommitted: false,
        resourceEvidenceCount: 0,
        rootBranchId: extension.rootBranchId,
      })
      const now = new Date()
      const [failedOperation] = await tx
        .update(capsuleOperations)
        .set({
          status: CapsuleOperationStatus.FAILED,
          failedAt: now,
          failureCode: failureCodeFromUnknown(error),
          failureMessage: failureMessageFromUnknown(error, 'Capsule creation failed before provider mutation.'),
          failureDetails:
            failureDetails === undefined
              ? undefined
              : toJsonObject(failureDetails, 'capsule create pre-provider failure details'),
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleOperations.id, operationId),
            eq(capsuleOperations.type, CapsuleOperationType.CREATE),
            inArray(capsuleOperations.status, NONTERMINAL_CREATE_STATUSES),
            isNull(capsuleOperations.providerMutationStartedAt),
          ),
        )
        .returning({
          id: capsuleOperations.id,
        })
      const [failedCapsule] = await tx
        .update(capsules)
        .set({
          lifecycleStatus: 'creation_failed',
          updatedAt: now,
        })
        .where(
          and(
            eq(capsules.id, operation.capsuleId),
            eq(capsules.ownerId, operation.ownerId),
            eq(capsules.lifecycleStatus, 'provisioning'),
          ),
        )
        .returning({
          lifecycleStatus: capsules.lifecycleStatus,
          archivedAt: capsules.archivedAt,
          destroyedAt: capsules.destroyedAt,
        })
      const [retiredBranch] = await tx
        .update(capsuleBranches)
        .set({
          status: 'destroyed',
          runtimeIp: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleBranches.id, extension.rootBranchId),
            eq(capsuleBranches.ownerId, operation.ownerId),
            eq(capsuleBranches.capsuleId, operation.capsuleId),
            eq(capsuleBranches.status, 'provisioning'),
            eq(capsuleBranches.isRootBranch, true),
          ),
        )
        .returning({
          id: capsuleBranches.id,
          capsuleId: capsuleBranches.capsuleId,
          name: capsuleBranches.name,
          status: capsuleBranches.status,
        })
      if (!failedOperation || !failedCapsule || !retiredBranch) {
        throw new IncusError('Failed to atomically finalize the pre-provider capsule create failure.', 'CONFLICT', {
          operationId,
          capsuleId: operation.capsuleId,
          rootBranchId: extension.rootBranchId,
        })
      }
      return {
        operation: toCapsuleOperationTransition({
          ownerId: operation.ownerId,
          operationId,
          capsuleId: operation.capsuleId,
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
   *
   * Complete extension and branch identity remain required. If that evidence is
   * missing or contradictory, the executor's fallback cleanup-required path
   * performs aggregate classification without claiming an ordinary compensated
   * failure.
   */
  public async failAfterSuccessfulCompensation(
    operationId: string,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<CreateCapsuleTerminalResult> {
    const details = createFailureDetails(error, context)
    const db = this.persistence.db
    const { capsuleOperations, capsules, capsuleBranches } = this.persistence.tables
    return await db.transaction(async tx => {
      const operation = await this.lockCreateOperation(tx, operationId)

      if (operation.status !== CapsuleOperationStatus.RUNNING || operation.providerMutationStartedAt === null) {
        throw new IncusError('Capsule create operation is not eligible for compensated failure.', 'CONFLICT', {
          operationId,
          operationStatus: operation.status,
          providerIntentCommitted: operation.providerMutationStartedAt !== null,
        })
      }

      const extension = await this.lockCreateOperationExtension(tx, operation.id)
      const capsule = await this.lockCapsule(tx, operation.ownerId, operation.capsuleId)
      const rootBranch = await this.lockBranchById(tx, extension.rootBranchId)

      this.assertCreateOperationExtensionConsistency(operation, extension, [rootBranch])

      if (capsule.lifecycleStatus !== 'provisioning' || rootBranch.status !== 'provisioning') {
        throw new IncusError('Capsule create aggregate cannot be classified as a compensated failure.', 'CONFLICT', {
          operationId,
          capsuleStatus: capsule.lifecycleStatus,
          branchStatus: rootBranch.status,
          rootBranchId: rootBranch.id,
        })
      }

      const now = new Date()
      const [failedOperation] = await tx
        .update(capsuleOperations)
        .set({
          status: CapsuleOperationStatus.FAILED,
          failedAt: now,
          failureCode: failureCodeFromUnknown(error),
          failureMessage: failureMessageFromUnknown(error, 'Capsule creation failed after provider compensation.'),
          failureDetails:
            details === undefined ? undefined : toJsonObject(details, 'capsule create compensated failure details'),
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleOperations.id, operationId),
            eq(capsuleOperations.type, CapsuleOperationType.CREATE),
            eq(capsuleOperations.status, CapsuleOperationStatus.RUNNING),
          ),
        )
        .returning({
          id: capsuleOperations.id,
        })

      const [failedCapsule] = await tx
        .update(capsules)
        .set({
          lifecycleStatus: 'creation_failed',
          updatedAt: now,
        })
        .where(
          and(
            eq(capsules.id, operation.capsuleId),
            eq(capsules.ownerId, operation.ownerId),
            eq(capsules.lifecycleStatus, 'provisioning'),
          ),
        )
        .returning({
          lifecycleStatus: capsules.lifecycleStatus,
          archivedAt: capsules.archivedAt,
          destroyedAt: capsules.destroyedAt,
        })

      // Preserve the durable root ID required by create receipt replay.
      const [retiredBranch] = await tx
        .update(capsuleBranches)
        .set({
          status: 'destroyed',
          runtimeIp: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleBranches.id, rootBranch.id),
            eq(capsuleBranches.ownerId, operation.ownerId),
            eq(capsuleBranches.capsuleId, operation.capsuleId),
            eq(capsuleBranches.status, 'provisioning'),
            eq(capsuleBranches.isRootBranch, true),
          ),
        )
        .returning({
          id: capsuleBranches.id,
          capsuleId: capsuleBranches.capsuleId,
          name: capsuleBranches.name,
          status: capsuleBranches.status,
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
   *
   * Cleanup classification deliberately tolerates a missing or contradictory
   * create extension. Such evidence is exactly why provider ownership or
   * aggregate identity may require manual inspection.
   */
  public async markCleanupRequired(
    operationId: string,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<CreateCapsuleTerminalResult> {
    const db = this.persistence.db
    return await db.transaction(async tx => {
      const operation = await this.lockCreateOperation(tx, operationId)
      if (!isNonterminalCreateStatus(operation.status)) {
        throw new IncusError('Capsule create operation is already terminal.', 'CONFLICT', {
          operationId,
          operationStatus: operation.status,
        })
      }
      const extension = await this.lockCreateOperationExtensionIfPresent(tx, operation.id)
      const capsule = await this.lockCapsule(tx, operation.ownerId, operation.capsuleId)
      const rootBranches = await this.lockRootBranchesForClassification(tx, operation.ownerId, operation.capsuleId)
      const rootBranch = this.selectRootBranchForClassification(extension, rootBranches)
      return await this.markCleanupRequiredInTransaction(tx, operation, capsule, rootBranch, error, {
        ...context,
        createExtensionPresent: extension !== null,
        createExtensionRootBranchId: extension?.rootBranchId ?? null,
        rootBranchCount: rootBranches.length,
      })
    })
  }

  // ---------------------------------------------------------------------------
  // Abandoned-operation classification
  // ---------------------------------------------------------------------------

  /**
   * Classifies a nonterminal create operation left by an earlier Worker.
   *
   * No executor is invoked and no provider state is inspected. Accepted or
   * running operations without provider intent use the same durable
   * pre-provider classification transaction as live executor failures.
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
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    operation: PersistedCreateOperation,
    capsule: PersistedCapsule,
    rootBranch: PersistedCapsuleBranch | null,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<CreateCapsuleTerminalResult> {
    if (!isNonterminalCreateStatus(operation.status)) {
      throw new IncusError('Capsule create operation is already terminal.', 'CONFLICT', {
        operationId: operation.id,
        operationStatus: operation.status,
      })
    }
    const { capsuleOperations, capsules, capsuleBranches } = this.persistence.tables
    const details = createFailureDetails(error, context)
    const now = new Date()
    const [cleanupOperation] = await tx
      .update(capsuleOperations)
      .set({
        status: CapsuleOperationStatus.CLEANUP_REQUIRED,
        failedAt: now,
        failureCode: failureCodeFromUnknown(error),
        failureMessage: failureMessageFromUnknown(error, 'Capsule creation requires manual cleanup.'),
        failureDetails:
          details === undefined ? undefined : toJsonObject(details, 'capsule create cleanup-required details'),
        updatedAt: now,
      })
      .where(
        and(
          eq(capsuleOperations.id, operation.id),
          eq(capsuleOperations.type, CapsuleOperationType.CREATE),
          inArray(capsuleOperations.status, NONTERMINAL_CREATE_STATUSES),
        ),
      )
      .returning({
        id: capsuleOperations.id,
      })
    const [cleanupCapsule] = await tx
      .update(capsules)
      .set({
        lifecycleStatus: 'cleanup_required',
        updatedAt: now,
      })
      .where(and(eq(capsules.id, capsule.id), eq(capsules.ownerId, operation.ownerId)))
      .returning({
        lifecycleStatus: capsules.lifecycleStatus,
        archivedAt: capsules.archivedAt,
        destroyedAt: capsules.destroyedAt,
      })
    let cleanupBranch: CreateCapsuleCommittedBranch | null = null
    if (rootBranch && rootBranch.status !== 'destroyed') {
      const [updatedBranch] = await tx
        .update(capsuleBranches)
        .set({
          status: 'cleanup_required',
          runtimeIp: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleBranches.id, rootBranch.id),
            eq(capsuleBranches.ownerId, operation.ownerId),
            eq(capsuleBranches.capsuleId, operation.capsuleId),
          ),
        )
        .returning({
          id: capsuleBranches.id,
          capsuleId: capsuleBranches.capsuleId,
          name: capsuleBranches.name,
          status: capsuleBranches.status,
        })
      cleanupBranch = updatedBranch ?? null
    } else if (rootBranch) {
      cleanupBranch = {
        id: rootBranch.id,
        capsuleId: rootBranch.capsuleId,
        name: rootBranch.name,
        status: rootBranch.status,
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
    if (operation.type !== CapsuleOperationType.CREATE) {
      throw new IncusError('Operation is not a capsule create operation.', 'CONFLICT', {
        operationId: operation.id,
        operationType: operation.type,
      })
    }

    const details = await this.loadValidatedCreateOperationDetails(operation)
    const db = this.persistence.db
    const capsules = this.persistence.tables.capsules

    const [capsule] = await db
      .select({
        lifecycleStatus: capsules.lifecycleStatus,
        archivedAt: capsules.archivedAt,
        destroyedAt: capsules.destroyedAt,
      })
      .from(capsules)
      .where(and(eq(capsules.id, operation.capsuleId), eq(capsules.ownerId, operation.ownerId)))
      .limit(1)

    if (!capsule) {
      throw new IncusError('Capsule create operation references a missing capsule aggregate.', 'API_ERROR', {
        operationId: operation.id,
        capsuleId: operation.capsuleId,
        rootBranchId: details.extension.rootBranchId,
      })
    }

    return {
      newlyAccepted,
      receipt: this.createCreateReceipt({
        operationId: operation.id,
        capsuleId: operation.capsuleId,
        rootBranchId: details.extension.rootBranchId,
        rootBranchName: details.extension.rootBranchName,
        operationStatus: operation.status,
        replayed,
      }),
      operation: toCapsuleOperationTransition({
        ownerId: operation.ownerId,
        operationId: operation.id,
        capsuleId: operation.capsuleId,
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
      branch: {
        id: details.rootBranch.id,
        capsuleId: details.rootBranch.capsuleId,
        name: details.rootBranch.name,
        status: details.rootBranch.status,
      },
    }
  }

  private async loadValidatedCreateOperationDetails(
    operation: PersistedCapsuleOperation,
  ): Promise<ValidatedCreateOperationDetails> {
    const extension = await this.loadCreateOperationExtension(operation.id)

    if (!extension) {
      throw new IncusError('Capsule create operation is missing its immutable create extension.', 'API_ERROR', {
        operationId: operation.id,
        capsuleId: operation.capsuleId,
      })
    }

    const rootBranch = await this.loadBranchById(extension.rootBranchId)

    if (!rootBranch) {
      throw new IncusError('Capsule create operation references a missing root branch.', 'API_ERROR', {
        operationId: operation.id,
        capsuleId: operation.capsuleId,
        rootBranchId: extension.rootBranchId,
      })
    }

    this.assertCreateOperationExtensionConsistency(operation, extension, [rootBranch])

    const pinnedBlueprint = this.parseAndValidatePinnedBlueprint(extension)
    const rootfsImagePin = this.readRootfsImagePin(extension, pinnedBlueprint.blueprintSnapshot)

    this.assertCreateOperationExtensionConsistency(operation, extension, [rootBranch])

    return {
      extension,
      rootBranch,
      blueprintDigest: pinnedBlueprint.blueprintDigest,
      blueprintSnapshot: pinnedBlueprint.blueprintSnapshot,
      rootfsImagePin,
    }
  }

  private assertIdempotentReplay(
    operation: PersistedCapsuleOperation,
    actor: CapsuleActorReference,
    requestHash: CapsuleOperationRequestHash,
  ): void {
    assertOperationReplayIdentity(operation, {
      operationType: CapsuleOperationType.CREATE,
      actor,
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
  // Private create-extension validation
  // ---------------------------------------------------------------------------

  /**
   * Validates the immutable relationship among the base operation, its create
   * extension, the root branch, and the pinned blueprint snapshot.
   *
   * This is repository policy because PostgreSQL foreign keys cannot enforce
   * the base operation's `create` discriminator or cross-table immutable field
   * agreement.
   */
  private assertCreateOperationExtensionConsistency(
    operation: Pick<PersistedCapsuleOperation, 'id' | 'ownerId' | 'capsuleId' | 'type'>,
    extension: PersistedCreateOperationExtension,
    rootBranches: readonly PersistedCapsuleBranch[],
  ): void {
    const contradictions = this.collectCreateOperationExtensionContradictions(operation, extension, rootBranches)

    if (contradictions.length === 0) {
      return
    }

    throw new IncusError(
      'Capsule create operation extension does not match its durable operation and root branch.',
      'CONFLICT',
      {
        operationId: operation.id,
        capsuleId: operation.capsuleId,
        rootBranchId: extension.rootBranchId,
        contradictions,
      },
    )
  }

  private collectCreateOperationExtensionContradictions(
    operation: Pick<PersistedCapsuleOperation, 'id' | 'ownerId' | 'capsuleId' | 'type'>,
    extension: PersistedCreateOperationExtension | null,
    rootBranches: readonly PersistedCapsuleBranch[],
  ): string[] {
    const contradictions: string[] = []

    if (operation.type !== CapsuleOperationType.CREATE) {
      contradictions.push('base_operation_type_is_not_create')
    }

    if (!extension) {
      contradictions.push('create_extension_missing')
    }

    if (rootBranches.length !== 1) {
      contradictions.push('root_branch_count_invalid')
    }

    if (!extension) {
      return contradictions
    }

    if (extension.operationId !== operation.id) {
      contradictions.push('create_extension_operation_id_mismatch')
    }

    const rootBranch = rootBranches.find(branch => branch.id === extension.rootBranchId)

    if (!rootBranch) {
      contradictions.push('create_extension_root_branch_reference_mismatch')
      return contradictions
    }

    if (!rootBranch.isRootBranch) {
      contradictions.push('referenced_branch_is_not_root')
    }

    if (rootBranch.ownerId !== operation.ownerId) {
      contradictions.push('root_branch_owner_mismatch')
    }

    if (rootBranch.capsuleId !== operation.capsuleId) {
      contradictions.push('root_branch_capsule_mismatch')
    }

    if (rootBranch.name !== extension.rootBranchName) {
      contradictions.push('root_branch_name_mismatch')
    }

    if (rootBranch.blueprintName !== extension.blueprintName) {
      contradictions.push('root_branch_blueprint_name_mismatch')
    }

    if (rootBranch.blueprintDigest !== extension.blueprintDigest) {
      contradictions.push('root_branch_blueprint_digest_mismatch')
    }

    if (rootBranch.cpu !== extension.cpu) {
      contradictions.push('root_branch_cpu_mismatch')
    }

    if (rootBranch.memory !== extension.memory) {
      contradictions.push('root_branch_memory_mismatch')
    }

    try {
      const pinnedBlueprint = this.parseAndValidatePinnedBlueprint(extension)
      this.readRootfsImagePin(extension, pinnedBlueprint.blueprintSnapshot)
    } catch {
      contradictions.push('create_extension_immutable_input_invalid')
    }

    return contradictions
  }

  private readRootfsImagePin(
    extension: PersistedCreateOperationExtension,
    blueprint: CapsuleBlueprint,
  ): CapsuleRootfsImagePin {
    return readRootfs(extension.rootfsImagePin, blueprint.image_alias, {
      operationId: extension.operationId,
      blueprintName: extension.blueprintName,
      blueprintDigest: extension.blueprintDigest,
    })
  }

  private parseAndValidatePinnedBlueprint(extension: PersistedCreateOperationExtension): {
    blueprintDigest: CapsuleBlueprintDigest
    blueprintSnapshot: CapsuleBlueprint
  } {
    const parsedDigest = CapsuleBlueprintDigestSchema.safeParse(extension.blueprintDigest)

    if (!parsedDigest.success) {
      throw new IncusError('Capsule create operation contains an invalid blueprint digest.', 'CONFLICT', {
        operationId: extension.operationId,
        blueprintDigest: extension.blueprintDigest,
      })
    }

    const parsedBlueprint = CapsuleBlueprintSchema.safeParse(extension.blueprintSnapshot)

    if (!parsedBlueprint.success) {
      throw new IncusError('Capsule create operation contains an invalid pinned blueprint snapshot.', 'CONFLICT', {
        operationId: extension.operationId,
        blueprintName: extension.blueprintName,
      })
    }

    if (parsedBlueprint.data.name !== extension.blueprintName) {
      throw new IncusError(
        'Capsule create operation blueprint snapshot name does not match its immutable blueprint identity.',
        'CONFLICT',
        {
          operationId: extension.operationId,
          blueprintName: extension.blueprintName,
          blueprintSnapshotName: parsedBlueprint.data.name,
        },
      )
    }

    const actualDigest = digestCanonicalJsonValue(parsedBlueprint.data, {
      context: `capsule create operation '${extension.operationId}' pinned blueprint`,
    })

    if (actualDigest !== parsedDigest.data) {
      throw new IncusError(
        'Capsule create operation blueprint snapshot does not match its immutable digest.',
        'CONFLICT',
        {
          operationId: extension.operationId,
          blueprintName: extension.blueprintName,
          expectedDigest: parsedDigest.data,
          actualDigest,
        },
      )
    }

    return {
      blueprintDigest: parsedDigest.data,
      blueprintSnapshot: parsedBlueprint.data,
    }
  }

  // ---------------------------------------------------------------------------
  // Private pre-provider safety proof
  // ---------------------------------------------------------------------------

  private collectPreProviderContradictions(
    operation: PersistedCreateOperation,
    extension: PersistedCreateOperationExtension | null,
    capsule: PersistedCapsule,
    rootBranches: readonly PersistedCapsuleBranch[],
    resourceEvidence: readonly PreProviderResourceEvidence[],
  ): string[] {
    const contradictions = this.collectCreateOperationExtensionContradictions(operation, extension, rootBranches)

    if (operation.providerMutationStartedAt !== null) {
      contradictions.push('provider_intent_present')
    }

    if (capsule.lifecycleStatus !== 'provisioning') {
      contradictions.push('capsule_not_provisioning')
    }

    if (capsule.archivedAt !== null) {
      contradictions.push('capsule_unexpectedly_archived')
    }

    const rootBranch = extension ? rootBranches.find(branch => branch.id === extension.rootBranchId) : null

    if (rootBranch && rootBranch.status !== 'provisioning') {
      contradictions.push('root_branch_not_provisioning')
    }

    if (resourceEvidence.length > 0) {
      contradictions.push('branch_resource_evidence_present_before_provider_intent')
    }

    return contradictions
  }

  private selectRootBranchForClassification(
    extension: PersistedCreateOperationExtension | null,
    rootBranches: readonly PersistedCapsuleBranch[],
  ): PersistedCapsuleBranch | null {
    if (extension) {
      const referencedRootBranch = rootBranches.find(branch => branch.id === extension.rootBranchId)

      if (referencedRootBranch) {
        return referencedRootBranch
      }
    }

    return rootBranches.length === 1 ? rootBranches[0]! : null
  }

  private async lockPreProviderResourceEvidence(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    operationId: string,
    rootBranchId: string | null,
  ): Promise<PreProviderResourceEvidence[]> {
    const capsuleBranchResources = this.persistence.tables.capsuleBranchResources
    const evidencePredicate =
      rootBranchId === null
        ? eq(capsuleBranchResources.createdByOperationId, operationId)
        : or(
            eq(capsuleBranchResources.createdByOperationId, operationId),
            eq(capsuleBranchResources.branchId, rootBranchId),
          )

    return await tx
      .select({
        id: capsuleBranchResources.id,
        branchId: capsuleBranchResources.branchId,
        resourceKey: capsuleBranchResources.resourceKey,
        resourceType: capsuleBranchResources.resourceType,
        status: capsuleBranchResources.status,
        createdByOperationId: capsuleBranchResources.createdByOperationId,
        lastOperationId: capsuleBranchResources.lastOperationId,
      })
      .from(capsuleBranchResources)
      .where(evidencePredicate)
      .orderBy(asc(capsuleBranchResources.id))
      .for('update')
  }

  // ---------------------------------------------------------------------------
  // Private read helpers
  // ---------------------------------------------------------------------------

  private async loadCreateOperationExtension(operationId: string): Promise<PersistedCreateOperationExtension | null> {
    const db = this.persistence.db
    const capsuleCreateOperations = this.persistence.tables.capsuleCreateOperations
    const [extension] = await db
      .select()
      .from(capsuleCreateOperations)
      .where(eq(capsuleCreateOperations.operationId, operationId))
      .limit(1)

    return extension ?? null
  }

  private async loadBranchById(branchId: string): Promise<PersistedCapsuleBranch | null> {
    const db = this.persistence.db
    const capsuleBranches = this.persistence.tables.capsuleBranches
    const [branch] = await db.select().from(capsuleBranches).where(eq(capsuleBranches.id, branchId)).limit(1)

    return branch ?? null
  }

  // ---------------------------------------------------------------------------
  // Private locking helpers
  // ---------------------------------------------------------------------------

  private async lockRootBranchesForClassification(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    ownerId: string,
    capsuleId: string,
  ): Promise<PersistedCapsuleBranch[]> {
    const capsuleBranches = this.persistence.tables.capsuleBranches
    return await tx
      .select()
      .from(capsuleBranches)
      .where(
        and(
          eq(capsuleBranches.ownerId, ownerId),
          eq(capsuleBranches.capsuleId, capsuleId),
          eq(capsuleBranches.isRootBranch, true),
        ),
      )
      .orderBy(asc(capsuleBranches.id))
      .for('update')
  }

  private async lockCreateOperation(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    operationId: string,
  ): Promise<PersistedCreateOperation> {
    const capsuleOperations = this.persistence.tables.capsuleOperations
    const [operation] = await tx
      .select()
      .from(capsuleOperations)
      .where(and(eq(capsuleOperations.id, operationId), eq(capsuleOperations.type, CapsuleOperationType.CREATE)))
      .for('update')
      .limit(1)

    if (!operation) {
      throw new IncusError('Capsule create operation was not found.', 'NOT_FOUND', {
        operationId,
      })
    }

    return operation
  }

  private async lockCreateOperationExtension(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    operationId: string,
  ): Promise<PersistedCreateOperationExtension> {
    const extension = await this.lockCreateOperationExtensionIfPresent(tx, operationId)

    if (!extension) {
      throw new IncusError('Capsule create operation is missing its immutable create extension.', 'CONFLICT', {
        operationId,
      })
    }

    return extension
  }

  private async lockCreateOperationExtensionIfPresent(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    operationId: string,
  ): Promise<PersistedCreateOperationExtension | null> {
    const capsuleCreateOperations = this.persistence.tables.capsuleCreateOperations
    const [extension] = await tx
      .select()
      .from(capsuleCreateOperations)
      .where(eq(capsuleCreateOperations.operationId, operationId))
      .for('update')
      .limit(1)

    return extension ?? null
  }

  private async lockCapsule(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    ownerId: string,
    capsuleId: string,
  ): Promise<PersistedCapsule> {
    const capsules = this.persistence.tables.capsules
    const [capsule] = await tx
      .select()
      .from(capsules)
      .where(and(eq(capsules.id, capsuleId), eq(capsules.ownerId, ownerId)))
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

  private async lockBranchById(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    branchId: string,
  ): Promise<PersistedCapsuleBranch> {
    const capsuleBranches = this.persistence.tables.capsuleBranches
    const [branch] = await tx
      .select()
      .from(capsuleBranches)
      .where(eq(capsuleBranches.id, branchId))
      .for('update')
      .limit(1)

    if (!branch) {
      throw new IncusError('Capsule create operation root branch was not found.', 'NOT_FOUND', {
        branchId,
      })
    }

    return branch
  }
}
