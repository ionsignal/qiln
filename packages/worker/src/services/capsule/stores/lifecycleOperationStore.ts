import { and, asc, eq, inArray } from 'drizzle-orm'
import {
  CapsuleArchiveOutputSchema,
  CapsuleBootstrapCreateOutputSchema,
  CapsuleDestroyOutputSchema,
  CapsuleLifecycleOperationStatus,
  CapsuleLifecycleOperationType,
  CapsuleUnarchiveOutputSchema,
  capsuleBranchesTable,
  capsuleLifecycleOperationsTable,
  capsulesTable,
  type CapsuleArchiveOutput,
  type CapsuleBootstrapCreateOutput,
  type CapsuleDestroyOutput,
  type CapsuleHostDbContract,
  type CapsuleLifecycleOperationStatusValue,
  type CapsuleLifecycleOperationTypeValue,
  type CapsuleUnarchiveOutput,
} from '@qiln/core/server'
import { IncusError, isUniqueConstraintViolation } from '../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from './errorDetails'
import { toJsonObject } from './jsonPersistence'
import type {
  AbandonedBootstrapLifecycleOperationCandidate,
  AbandonedDestroyLifecycleOperationCandidate,
  AcceptBootstrapLifecycleOperationInput,
  AcceptedBootstrapLifecycleOperation,
  AcceptDestroyLifecycleOperationInput,
  AcceptedDestroyLifecycleOperation,
  ArchiveCapsuleInput,
  CapsuleLifecycleReceiptRecord,
  DestroyingCapsuleBranch,
  UnarchiveCapsuleInput,
} from './types'

const NON_TERMINAL_LIFECYCLE_OPERATION_STATUSES = [CapsuleLifecycleOperationStatus.ACCEPTED, CapsuleLifecycleOperationStatus.RUNNING] as const

export interface FinalizeCompensatedBootstrapFailureInput {
  ownerId: string
  capsuleId: string
  operationId: string
  branchId: string
  error: unknown
  failureContext?: Record<string, unknown>
}

function toIsoTimestamp(value: Date | null): string | null {
  return value === null ? null : value.toISOString()
}

/**
 * Persistence boundary for capsule lifecycle operation identity and aggregate transitions.
 *
 * Transactions that alter a capsule and its branches live here so lifecycle state cannot
 * be committed independently from operation accounting.
 */
export class CapsuleLifecycleOperationStore {
  constructor(private readonly db: CapsuleHostDbContract) {}

  public async findExistingBootstrapOperationReceipt(
    ownerId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<CapsuleBootstrapCreateOutput | null> {
    const operation = await this.findOperationByOwnerIdempotencyKey(ownerId, idempotencyKey)
    if (!operation) {
      return null
    }
    this.assertIdempotentOperation(operation.type, operation.requestHash, CapsuleLifecycleOperationType.BOOTSTRAP, requestHash, idempotencyKey)
    const branch = await this.findOperationBranch(ownerId, operation.branchId)
    if (!operation.branchName) {
      throw new IncusError('Bootstrap lifecycle operation has no durable branch name.', 'API_ERROR', {
        operationId: operation.id,
      })
    }
    return this.createBootstrapOutput(
      operation.id,
      operation.capsuleId,
      operation.status,
      operation.branchName,
      branch?.status ?? this.fallbackBootstrapBranchStatus(operation.status),
      true,
    )
  }

  /**
   * Atomically creates the capsule aggregate, bootstrap lifecycle operation, and unique root
   * branch before provisioning begins.
   */
  public async acceptBootstrapOperation(input: AcceptBootstrapLifecycleOperationInput): Promise<AcceptedBootstrapLifecycleOperation> {
    try {
      const now = new Date()
      return await this.db.transaction(async tx => {
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
          })

        if (!capsule) {
          throw new IncusError('Failed to create capsule aggregate.', 'API_ERROR')
        }
        const [operation] = await tx
          .insert(capsuleLifecycleOperationsTable)
          .values({
            ownerId: input.ownerId,
            capsuleId: capsule.id,
            type: CapsuleLifecycleOperationType.BOOTSTRAP,
            status: CapsuleLifecycleOperationStatus.ACCEPTED,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            branchName: input.bootstrapBranchName,
            blueprintName: input.blueprintName,
            blueprintDigest: input.blueprintDigest,
            blueprintSnapshot: input.blueprintSnapshot,
            createdAt: now,
            updatedAt: now,
          })
          .returning({
            id: capsuleLifecycleOperationsTable.id,
          })
        if (!operation) {
          throw new IncusError('Failed to create durable capsule bootstrap lifecycle operation.', 'API_ERROR')
        }
        const [branch] = await tx
          .insert(capsuleBranchesTable)
          .values({
            ownerId: input.ownerId,
            capsuleId: capsule.id,
            name: input.bootstrapBranchName,
            blueprintName: input.blueprintName,
            blueprintDigest: input.blueprintDigest,
            cpu: input.cpu,
            memory: input.memory,
            status: 'provisioning',
            isRootBranch: true,
            createdAt: now,
            updatedAt: now,
          })
          .returning({
            id: capsuleBranchesTable.id,
          })
        if (!branch) {
          throw new IncusError('Failed to create capsule root branch provisioning record.', 'API_ERROR')
        }
        const [runningOperation] = await tx
          .update(capsuleLifecycleOperationsTable)
          .set({
            branchId: branch.id,
            status: CapsuleLifecycleOperationStatus.RUNNING,
            startedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(capsuleLifecycleOperationsTable.id, operation.id),
              eq(capsuleLifecycleOperationsTable.status, CapsuleLifecycleOperationStatus.ACCEPTED),
            ),
          )
          .returning({
            id: capsuleLifecycleOperationsTable.id,
          })
        if (!runningOperation) {
          throw new IncusError('Failed to mark capsule bootstrap lifecycle operation as running.', 'API_ERROR')
        }
        return {
          operationId: runningOperation.id,
          capsuleId: capsule.id,
          branchId: branch.id,
        }
      })
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) {
        throw error
      }
      const replayedReceipt = await this.findExistingBootstrapOperationReceipt(input.ownerId, input.idempotencyKey, input.requestHash)
      if (replayedReceipt) {
        return {
          replayedReceipt,
        }
      }
      const [existingActiveBranch] = await this.db
        .select({
          id: capsuleBranchesTable.id,
        })
        .from(capsuleBranchesTable)
        .where(
          and(
            eq(capsuleBranchesTable.ownerId, input.ownerId),
            eq(capsuleBranchesTable.name, input.bootstrapBranchName),
            inArray(capsuleBranchesTable.status, [
              'provisioning',
              'offline',
              'starting',
              'online',
              'stopping',
              'destroying',
              'error',
              'cleanup_required',
            ]),
          ),
        )
        .limit(1)
      if (existingActiveBranch) {
        throw new IncusError(`Capsule branch '${input.bootstrapBranchName}' already exists.`, 'CONFLICT')
      }
      throw new IncusError('Capsule bootstrap lifecycle operation conflicts with an existing durable operation.', 'CONFLICT')
    }
  }

  /**
   * Finalizes a successful bootstrap in one aggregate transaction. The root branch cannot become
   * usable independently from the capsule becoming active.
   */
  public async finalizeBootstrapAggregateActive(ownerId: string, capsuleId: string, branchId: string): Promise<{ branchName: string }> {
    return await this.db.transaction(async tx => {
      const [capsule] = await tx
        .select({
          id: capsulesTable.id,
          lifecycleStatus: capsulesTable.lifecycleStatus,
          archivedAt: capsulesTable.archivedAt,
        })
        .from(capsulesTable)
        .where(and(eq(capsulesTable.id, capsuleId), eq(capsulesTable.ownerId, ownerId)))
        .for('update')
        .limit(1)
      if (!capsule) {
        throw new IncusError('Capsule aggregate not found while finalizing bootstrap.', 'NOT_FOUND', {
          ownerId,
          capsuleId,
          branchId,
        })
      }
      if (capsule.lifecycleStatus !== 'provisioning' || capsule.archivedAt !== null) {
        throw new IncusError('Capsule aggregate is not eligible for bootstrap finalization.', 'CONFLICT', {
          capsuleId,
          lifecycleStatus: capsule.lifecycleStatus,
          archived: capsule.archivedAt !== null,
        })
      }
      const [branch] = await tx
        .select({
          id: capsuleBranchesTable.id,
          name: capsuleBranchesTable.name,
          status: capsuleBranchesTable.status,
          isRootBranch: capsuleBranchesTable.isRootBranch,
        })
        .from(capsuleBranchesTable)
        .where(
          and(eq(capsuleBranchesTable.id, branchId), eq(capsuleBranchesTable.ownerId, ownerId), eq(capsuleBranchesTable.capsuleId, capsuleId)),
        )
        .for('update')
        .limit(1)
      if (!branch || !branch.isRootBranch || branch.status !== 'provisioning') {
        throw new IncusError('Capsule root branch is not eligible for bootstrap finalization.', 'CONFLICT', {
          ownerId,
          capsuleId,
          branchId,
          branchStatus: branch?.status ?? null,
          isRootBranch: branch?.isRootBranch ?? null,
        })
      }
      const now = new Date()
      const transitionedBranches = await tx
        .update(capsuleBranchesTable)
        .set({
          status: 'offline',
          updatedAt: now,
        })
        .where(and(eq(capsuleBranchesTable.id, branchId), eq(capsuleBranchesTable.status, 'provisioning')))
        .returning({
          name: capsuleBranchesTable.name,
        })
      if (transitionedBranches.length !== 1) {
        throw new IncusError('Failed to finalize the capsule root branch offline.', 'CONFLICT', {
          ownerId,
          capsuleId,
          branchId,
        })
      }
      const transitionedCapsules = await tx
        .update(capsulesTable)
        .set({
          lifecycleStatus: 'active',
          updatedAt: now,
        })
        .where(and(eq(capsulesTable.id, capsuleId), eq(capsulesTable.ownerId, ownerId), eq(capsulesTable.lifecycleStatus, 'provisioning')))
        .returning({
          id: capsulesTable.id,
        })
      if (transitionedCapsules.length !== 1) {
        throw new IncusError('Failed to activate the capsule aggregate after bootstrap.', 'CONFLICT', {
          ownerId,
          capsuleId,
          branchId,
        })
      }
      return {
        branchName: transitionedBranches[0]!.name,
      }
    })
  }

  /**
   * Commits the terminal result of a fully compensated bootstrap.
   *
   * Provider compensation is complete before this transaction begins. The branch removal, capsule
   * terminal state, and failed operation accounting are committed together so a crash cannot leave
   * the capsule provisioning after its root branch has been removed.
   */
  public async finalizeCompensatedBootstrapFailure(input: FinalizeCompensatedBootstrapFailureInput): Promise<{ branchName: string }> {
    const failureDetails = createFailureDetails(input.error, input.failureContext)
    return await this.db.transaction(async tx => {
      const [capsule] = await tx
        .select({
          id: capsulesTable.id,
          lifecycleStatus: capsulesTable.lifecycleStatus,
          archivedAt: capsulesTable.archivedAt,
        })
        .from(capsulesTable)
        .where(and(eq(capsulesTable.id, input.capsuleId), eq(capsulesTable.ownerId, input.ownerId)))
        .for('update')
        .limit(1)
      if (!capsule) {
        throw new IncusError('Compensated bootstrap references a missing capsule aggregate.', 'NOT_FOUND', {
          ownerId: input.ownerId,
          capsuleId: input.capsuleId,
          operationId: input.operationId,
          branchId: input.branchId,
        })
      }
      if (capsule.lifecycleStatus !== 'provisioning' || capsule.archivedAt !== null) {
        throw new IncusError('Capsule aggregate is not eligible for compensated bootstrap finalization.', 'CONFLICT', {
          capsuleId: input.capsuleId,
          lifecycleStatus: capsule.lifecycleStatus,
          archived: capsule.archivedAt !== null,
        })
      }
      const [operation] = await tx
        .select({
          id: capsuleLifecycleOperationsTable.id,
          type: capsuleLifecycleOperationsTable.type,
          status: capsuleLifecycleOperationsTable.status,
          branchId: capsuleLifecycleOperationsTable.branchId,
        })
        .from(capsuleLifecycleOperationsTable)
        .where(
          and(
            eq(capsuleLifecycleOperationsTable.id, input.operationId),
            eq(capsuleLifecycleOperationsTable.ownerId, input.ownerId),
            eq(capsuleLifecycleOperationsTable.capsuleId, input.capsuleId),
          ),
        )
        .for('update')
        .limit(1)
      if (
        !operation ||
        operation.type !== CapsuleLifecycleOperationType.BOOTSTRAP ||
        operation.status !== CapsuleLifecycleOperationStatus.RUNNING ||
        operation.branchId !== input.branchId
      ) {
        throw new IncusError('Bootstrap lifecycle operation is not eligible for compensated failure finalization.', 'CONFLICT', {
          operationId: input.operationId,
          capsuleId: input.capsuleId,
          branchId: input.branchId,
          operationType: operation?.type ?? null,
          operationStatus: operation?.status ?? null,
          operationBranchId: operation?.branchId ?? null,
        })
      }
      const [branch] = await tx
        .select({
          id: capsuleBranchesTable.id,
          name: capsuleBranchesTable.name,
          status: capsuleBranchesTable.status,
          isRootBranch: capsuleBranchesTable.isRootBranch,
        })
        .from(capsuleBranchesTable)
        .where(
          and(
            eq(capsuleBranchesTable.id, input.branchId),
            eq(capsuleBranchesTable.ownerId, input.ownerId),
            eq(capsuleBranchesTable.capsuleId, input.capsuleId),
          ),
        )
        .for('update')
        .limit(1)
      if (!branch || !branch.isRootBranch || branch.status !== 'provisioning') {
        throw new IncusError('Bootstrap root branch is not eligible for compensated removal.', 'CONFLICT', {
          capsuleId: input.capsuleId,
          branchId: input.branchId,
          branchStatus: branch?.status ?? null,
          isRootBranch: branch?.isRootBranch ?? null,
        })
      }
      const now = new Date()
      const deletedBranches = await tx
        .delete(capsuleBranchesTable)
        .where(
          and(
            eq(capsuleBranchesTable.id, input.branchId),
            eq(capsuleBranchesTable.ownerId, input.ownerId),
            eq(capsuleBranchesTable.capsuleId, input.capsuleId),
            eq(capsuleBranchesTable.status, 'provisioning'),
            eq(capsuleBranchesTable.isRootBranch, true),
          ),
        )
        .returning({
          name: capsuleBranchesTable.name,
        })
      if (deletedBranches.length !== 1) {
        throw new IncusError('Failed to remove the fully compensated bootstrap root branch.', 'CONFLICT', {
          capsuleId: input.capsuleId,
          branchId: input.branchId,
        })
      }
      const transitionedCapsules = await tx
        .update(capsulesTable)
        .set({
          lifecycleStatus: 'creation_failed',
          updatedAt: now,
        })
        .where(
          and(
            eq(capsulesTable.id, input.capsuleId),
            eq(capsulesTable.ownerId, input.ownerId),
            eq(capsulesTable.lifecycleStatus, 'provisioning'),
          ),
        )
        .returning({
          id: capsulesTable.id,
        })
      if (transitionedCapsules.length !== 1) {
        throw new IncusError('Failed to mark the fully compensated capsule creation as failed.', 'CONFLICT', {
          capsuleId: input.capsuleId,
          operationId: input.operationId,
        })
      }
      const failedOperations = await tx
        .update(capsuleLifecycleOperationsTable)
        .set({
          branchId: null,
          status: CapsuleLifecycleOperationStatus.FAILED,
          failedAt: now,
          updatedAt: now,
          failureCode: failureCodeFromUnknown(input.error),
          failureMessage: failureMessageFromUnknown(input.error, 'Capsule bootstrap failed after complete provider compensation.'),
          failureDetails:
            failureDetails === undefined ? undefined : toJsonObject(failureDetails, 'compensated capsule bootstrap failure details'),
        })
        .where(
          and(
            eq(capsuleLifecycleOperationsTable.id, input.operationId),
            eq(capsuleLifecycleOperationsTable.ownerId, input.ownerId),
            eq(capsuleLifecycleOperationsTable.capsuleId, input.capsuleId),
            eq(capsuleLifecycleOperationsTable.type, CapsuleLifecycleOperationType.BOOTSTRAP),
            eq(capsuleLifecycleOperationsTable.status, CapsuleLifecycleOperationStatus.RUNNING),
          ),
        )
        .returning({
          id: capsuleLifecycleOperationsTable.id,
        })
      if (failedOperations.length !== 1) {
        throw new IncusError('Failed to finalize the compensated bootstrap lifecycle operation.', 'CONFLICT', {
          capsuleId: input.capsuleId,
          operationId: input.operationId,
        })
      }
      return {
        branchName: deletedBranches[0]!.name,
      }
    })
  }

  public async archiveCapsule(input: ArchiveCapsuleInput): Promise<CapsuleArchiveOutput> {
    const existing = await this.findExistingLifecycleReceipt(
      input.ownerId,
      input.idempotencyKey,
      input.requestHash,
      CapsuleLifecycleOperationType.ARCHIVE,
    )
    if (existing) {
      return CapsuleArchiveOutputSchema.parse(this.toProtocolLifecycleReceipt(existing))
    }
    try {
      return await this.db.transaction(async tx => {
        const [capsule] = await tx
          .select()
          .from(capsulesTable)
          .where(and(eq(capsulesTable.id, input.capsuleId), eq(capsulesTable.ownerId, input.ownerId)))
          .for('update')
          .limit(1)
        if (!capsule) {
          throw new IncusError('Capsule not found or access denied.', 'NOT_FOUND', {
            capsuleId: input.capsuleId,
          })
        }
        if (capsule.lifecycleStatus !== 'active') {
          throw new IncusError('Only an active capsule can be archived.', 'CONFLICT', {
            capsuleId: input.capsuleId,
            lifecycleStatus: capsule.lifecycleStatus,
          })
        }
        if (capsule.archivedAt !== null) {
          throw new IncusError('Capsule is already archived.', 'CONFLICT', {
            capsuleId: input.capsuleId,
          })
        }
        const branches = await tx
          .select({
            id: capsuleBranchesTable.id,
            status: capsuleBranchesTable.status,
            isRootBranch: capsuleBranchesTable.isRootBranch,
          })
          .from(capsuleBranchesTable)
          .where(eq(capsuleBranchesTable.capsuleId, input.capsuleId))
          .orderBy(asc(capsuleBranchesTable.id))
          .for('update')
        this.assertArchiveBranchState(input.capsuleId, branches)
        const now = new Date()
        const [operation] = await tx
          .insert(capsuleLifecycleOperationsTable)
          .values({
            ownerId: input.ownerId,
            capsuleId: input.capsuleId,
            type: CapsuleLifecycleOperationType.ARCHIVE,
            status: CapsuleLifecycleOperationStatus.COMPLETED,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            startedAt: now,
            completedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning({
            id: capsuleLifecycleOperationsTable.id,
          })
        if (!operation) {
          throw new IncusError('Failed to record capsule archive lifecycle operation.', 'API_ERROR')
        }
        const [archived] = await tx
          .update(capsulesTable)
          .set({
            archivedAt: now,
            updatedAt: now,
          })
          .where(
            and(eq(capsulesTable.id, input.capsuleId), eq(capsulesTable.ownerId, input.ownerId), eq(capsulesTable.lifecycleStatus, 'active')),
          )
          .returning({
            lifecycleStatus: capsulesTable.lifecycleStatus,
            archivedAt: capsulesTable.archivedAt,
            destroyedAt: capsulesTable.destroyedAt,
          })
        if (!archived || archived.archivedAt === null) {
          throw new IncusError('Failed to persist capsule archive state.', 'CONFLICT', {
            capsuleId: input.capsuleId,
          })
        }
        return CapsuleArchiveOutputSchema.parse({
          operationId: operation.id,
          operationType: CapsuleLifecycleOperationType.ARCHIVE,
          operationStatus: CapsuleLifecycleOperationStatus.COMPLETED,
          capsuleId: input.capsuleId,
          lifecycleStatus: archived.lifecycleStatus,
          archivedAt: archived.archivedAt.toISOString(),
          destroyedAt: toIsoTimestamp(archived.destroyedAt),
          replayed: false,
        })
      })
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) {
        throw error
      }
      const replayed = await this.findExistingLifecycleReceipt(
        input.ownerId,
        input.idempotencyKey,
        input.requestHash,
        CapsuleLifecycleOperationType.ARCHIVE,
      )
      if (replayed) {
        return CapsuleArchiveOutputSchema.parse(this.toProtocolLifecycleReceipt(replayed))
      }
      throw new IncusError('Capsule archive lifecycle operation conflicts with an existing durable operation.', 'CONFLICT')
    }
  }

  public async unarchiveCapsule(input: UnarchiveCapsuleInput): Promise<CapsuleUnarchiveOutput> {
    const existing = await this.findExistingLifecycleReceipt(
      input.ownerId,
      input.idempotencyKey,
      input.requestHash,
      CapsuleLifecycleOperationType.UNARCHIVE,
    )
    if (existing) {
      return CapsuleUnarchiveOutputSchema.parse(this.toProtocolLifecycleReceipt(existing))
    }
    try {
      return await this.db.transaction(async tx => {
        const [capsule] = await tx
          .select()
          .from(capsulesTable)
          .where(and(eq(capsulesTable.id, input.capsuleId), eq(capsulesTable.ownerId, input.ownerId)))
          .for('update')
          .limit(1)
        if (!capsule) {
          throw new IncusError('Capsule not found or access denied.', 'NOT_FOUND', {
            capsuleId: input.capsuleId,
          })
        }
        if (capsule.lifecycleStatus !== 'active') {
          throw new IncusError('Only an active capsule can be unarchived.', 'CONFLICT', {
            capsuleId: input.capsuleId,
            lifecycleStatus: capsule.lifecycleStatus,
          })
        }
        if (capsule.archivedAt === null) {
          throw new IncusError('Capsule is not archived.', 'CONFLICT', {
            capsuleId: input.capsuleId,
          })
        }
        const now = new Date()
        const [operation] = await tx
          .insert(capsuleLifecycleOperationsTable)
          .values({
            ownerId: input.ownerId,
            capsuleId: input.capsuleId,
            type: CapsuleLifecycleOperationType.UNARCHIVE,
            status: CapsuleLifecycleOperationStatus.COMPLETED,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            startedAt: now,
            completedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning({
            id: capsuleLifecycleOperationsTable.id,
          })
        if (!operation) {
          throw new IncusError('Failed to record capsule unarchive lifecycle operation.', 'API_ERROR')
        }
        const [unarchived] = await tx
          .update(capsulesTable)
          .set({
            archivedAt: null,
            updatedAt: now,
          })
          .where(
            and(eq(capsulesTable.id, input.capsuleId), eq(capsulesTable.ownerId, input.ownerId), eq(capsulesTable.lifecycleStatus, 'active')),
          )
          .returning({
            lifecycleStatus: capsulesTable.lifecycleStatus,
            archivedAt: capsulesTable.archivedAt,
            destroyedAt: capsulesTable.destroyedAt,
          })

        if (!unarchived || unarchived.archivedAt !== null) {
          throw new IncusError('Failed to clear capsule archive state.', 'CONFLICT', {
            capsuleId: input.capsuleId,
          })
        }
        return CapsuleUnarchiveOutputSchema.parse({
          operationId: operation.id,
          operationType: CapsuleLifecycleOperationType.UNARCHIVE,
          operationStatus: CapsuleLifecycleOperationStatus.COMPLETED,
          capsuleId: input.capsuleId,
          lifecycleStatus: unarchived.lifecycleStatus,
          archivedAt: null,
          destroyedAt: toIsoTimestamp(unarchived.destroyedAt),
          replayed: false,
        })
      })
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) {
        throw error
      }
      const replayed = await this.findExistingLifecycleReceipt(
        input.ownerId,
        input.idempotencyKey,
        input.requestHash,
        CapsuleLifecycleOperationType.UNARCHIVE,
      )
      if (replayed) {
        return CapsuleUnarchiveOutputSchema.parse(this.toProtocolLifecycleReceipt(replayed))
      }
      throw new IncusError('Capsule unarchive lifecycle operation conflicts with an existing durable operation.', 'CONFLICT')
    }
  }

  public async findExistingDestroyOperationReceipt(
    ownerId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<CapsuleDestroyOutput | null> {
    const receipt = await this.findExistingLifecycleReceipt(ownerId, idempotencyKey, requestHash, CapsuleLifecycleOperationType.DESTROY)
    return receipt === null ? null : CapsuleDestroyOutputSchema.parse(this.toProtocolLifecycleReceipt(receipt))
  }

  public async acceptDestroyOperation(input: AcceptDestroyLifecycleOperationInput): Promise<AcceptedDestroyLifecycleOperation> {
    const existingReceipt = await this.findExistingLifecycleReceipt(
      input.ownerId,
      input.idempotencyKey,
      input.requestHash,
      CapsuleLifecycleOperationType.DESTROY,
    )
    if (existingReceipt) {
      return {
        replayedReceipt: existingReceipt,
      }
    }
    try {
      return await this.db.transaction(async tx => {
        const [capsule] = await tx
          .select()
          .from(capsulesTable)
          .where(and(eq(capsulesTable.id, input.capsuleId), eq(capsulesTable.ownerId, input.ownerId)))
          .for('update')
          .limit(1)
        if (!capsule) {
          throw new IncusError('Capsule not found or access denied.', 'NOT_FOUND', {
            capsuleId: input.capsuleId,
          })
        }
        if (capsule.lifecycleStatus !== 'active' || capsule.archivedAt === null) {
          throw new IncusError('Capsule must be active and archived before it can be destroyed.', 'CONFLICT', {
            capsuleId: input.capsuleId,
            lifecycleStatus: capsule.lifecycleStatus,
            archived: capsule.archivedAt !== null,
          })
        }
        const branches = await tx
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
          .where(eq(capsuleBranchesTable.capsuleId, input.capsuleId))
          .orderBy(asc(capsuleBranchesTable.id))
          .for('update')
        this.assertDestroyBranchState(input.capsuleId, branches)
        const now = new Date()
        const [operation] = await tx
          .insert(capsuleLifecycleOperationsTable)
          .values({
            ownerId: input.ownerId,
            capsuleId: input.capsuleId,
            type: CapsuleLifecycleOperationType.DESTROY,
            status: CapsuleLifecycleOperationStatus.RUNNING,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            startedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning({
            id: capsuleLifecycleOperationsTable.id,
          })
        if (!operation) {
          throw new IncusError('Failed to create durable capsule destroy lifecycle operation.', 'API_ERROR')
        }
        const transitionedCapsules = await tx
          .update(capsulesTable)
          .set({
            lifecycleStatus: 'destroying',
            updatedAt: now,
          })
          .where(
            and(eq(capsulesTable.id, input.capsuleId), eq(capsulesTable.ownerId, input.ownerId), eq(capsulesTable.lifecycleStatus, 'active')),
          )
          .returning({
            id: capsulesTable.id,
          })
        if (transitionedCapsules.length !== 1) {
          throw new IncusError('Failed to transition capsule into destroying state.', 'CONFLICT', {
            capsuleId: input.capsuleId,
          })
        }
        const transitionedBranches = await tx
          .update(capsuleBranchesTable)
          .set({
            status: 'destroying',
            updatedAt: now,
          })
          .where(and(eq(capsuleBranchesTable.capsuleId, input.capsuleId), eq(capsuleBranchesTable.status, 'offline')))
          .returning({
            id: capsuleBranchesTable.id,
          })
        if (transitionedBranches.length !== branches.length) {
          throw new IncusError('Failed to transition every capsule branch into destroying state.', 'CONFLICT', {
            capsuleId: input.capsuleId,
            expectedBranchCount: branches.length,
            transitionedBranchCount: transitionedBranches.length,
          })
        }
        return {
          operationId: operation.id,
          capsuleId: input.capsuleId,
          branches: branches.map(branch => ({
            ...branch,
            status: 'destroying',
          })),
        }
      })
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) {
        throw error
      }
      const replayedReceipt = await this.findExistingLifecycleReceipt(
        input.ownerId,
        input.idempotencyKey,
        input.requestHash,
        CapsuleLifecycleOperationType.DESTROY,
      )
      if (replayedReceipt) {
        return {
          replayedReceipt,
        }
      }
      throw new IncusError('Capsule destroy lifecycle operation conflicts with an existing durable operation.', 'CONFLICT')
    }
  }

  public async finalizeDestroyOperation(ownerId: string, capsuleId: string, operationId: string): Promise<CapsuleDestroyOutput> {
    return await this.db.transaction(async tx => {
      const [capsule] = await tx
        .select()
        .from(capsulesTable)
        .where(and(eq(capsulesTable.id, capsuleId), eq(capsulesTable.ownerId, ownerId)))
        .for('update')
        .limit(1)
      if (!capsule || capsule.lifecycleStatus !== 'destroying' || capsule.archivedAt === null) {
        throw new IncusError('Capsule is not eligible for terminal destroy finalization.', 'CONFLICT', {
          ownerId,
          capsuleId,
          lifecycleStatus: capsule?.lifecycleStatus ?? null,
          archived: capsule?.archivedAt !== null,
        })
      }
      const branches = await tx
        .select({
          id: capsuleBranchesTable.id,
          status: capsuleBranchesTable.status,
        })
        .from(capsuleBranchesTable)
        .where(eq(capsuleBranchesTable.capsuleId, capsuleId))
        .orderBy(asc(capsuleBranchesTable.id))
        .for('update')
      if (branches.length === 0 || branches.some(branch => branch.status !== 'destroying')) {
        throw new IncusError('Every capsule branch must remain destroying until terminal finalization.', 'CONFLICT', {
          capsuleId,
          branchCount: branches.length,
          branchStatuses: branches.map(branch => ({
            branchId: branch.id,
            status: branch.status,
          })),
        })
      }
      const [operation] = await tx
        .select({
          id: capsuleLifecycleOperationsTable.id,
          status: capsuleLifecycleOperationsTable.status,
          type: capsuleLifecycleOperationsTable.type,
        })
        .from(capsuleLifecycleOperationsTable)
        .where(
          and(
            eq(capsuleLifecycleOperationsTable.id, operationId),
            eq(capsuleLifecycleOperationsTable.ownerId, ownerId),
            eq(capsuleLifecycleOperationsTable.capsuleId, capsuleId),
          ),
        )
        .for('update')
        .limit(1)
      if (
        !operation ||
        operation.type !== CapsuleLifecycleOperationType.DESTROY ||
        operation.status !== CapsuleLifecycleOperationStatus.RUNNING
      ) {
        throw new IncusError('Destroy lifecycle operation is not eligible for terminal finalization.', 'CONFLICT', {
          operationId,
          capsuleId,
          operationType: operation?.type ?? null,
          operationStatus: operation?.status ?? null,
        })
      }
      const now = new Date()
      const transitionedBranches = await tx
        .update(capsuleBranchesTable)
        .set({
          status: 'destroyed',
          runtimeIp: null,
          updatedAt: now,
        })
        .where(and(eq(capsuleBranchesTable.capsuleId, capsuleId), eq(capsuleBranchesTable.status, 'destroying')))
        .returning({
          id: capsuleBranchesTable.id,
        })
      if (transitionedBranches.length !== branches.length) {
        throw new IncusError('Failed to finalize every capsule branch as destroyed.', 'CONFLICT', {
          capsuleId,
          expectedBranchCount: branches.length,
          transitionedBranchCount: transitionedBranches.length,
        })
      }
      const [destroyedCapsule] = await tx
        .update(capsulesTable)
        .set({
          lifecycleStatus: 'destroyed',
          destroyedAt: now,
          updatedAt: now,
        })
        .where(and(eq(capsulesTable.id, capsuleId), eq(capsulesTable.lifecycleStatus, 'destroying')))
        .returning({
          lifecycleStatus: capsulesTable.lifecycleStatus,
          archivedAt: capsulesTable.archivedAt,
          destroyedAt: capsulesTable.destroyedAt,
        })
      if (!destroyedCapsule || destroyedCapsule.destroyedAt === null) {
        throw new IncusError('Failed to finalize the capsule aggregate as destroyed.', 'CONFLICT', {
          capsuleId,
        })
      }
      const completedOperations = await tx
        .update(capsuleLifecycleOperationsTable)
        .set({
          status: CapsuleLifecycleOperationStatus.COMPLETED,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleLifecycleOperationsTable.id, operationId),
            eq(capsuleLifecycleOperationsTable.status, CapsuleLifecycleOperationStatus.RUNNING),
          ),
        )
        .returning({
          id: capsuleLifecycleOperationsTable.id,
        })
      if (completedOperations.length !== 1) {
        throw new IncusError('Failed to complete the capsule destroy lifecycle operation.', 'CONFLICT', {
          operationId,
          capsuleId,
        })
      }
      return CapsuleDestroyOutputSchema.parse({
        operationId,
        capsuleId,
        operationType: CapsuleLifecycleOperationType.DESTROY,
        operationStatus: CapsuleLifecycleOperationStatus.COMPLETED,
        lifecycleStatus: destroyedCapsule.lifecycleStatus,
        archivedAt: toIsoTimestamp(destroyedCapsule.archivedAt),
        destroyedAt: destroyedCapsule.destroyedAt.toISOString(),
        replayed: false,
      })
    })
  }

  public async listAbandonedBootstrapOperationCandidates(): Promise<AbandonedBootstrapLifecycleOperationCandidate[]> {
    return await this.db
      .select({
        id: capsuleLifecycleOperationsTable.id,
        capsuleId: capsuleLifecycleOperationsTable.capsuleId,
        ownerId: capsuleLifecycleOperationsTable.ownerId,
        branchId: capsuleLifecycleOperationsTable.branchId,
        branchName: capsuleLifecycleOperationsTable.branchName,
        status: capsuleLifecycleOperationsTable.status,
        createdAt: capsuleLifecycleOperationsTable.createdAt,
        updatedAt: capsuleLifecycleOperationsTable.updatedAt,
      })
      .from(capsuleLifecycleOperationsTable)
      .where(
        and(
          eq(capsuleLifecycleOperationsTable.type, CapsuleLifecycleOperationType.BOOTSTRAP),
          inArray(capsuleLifecycleOperationsTable.status, NON_TERMINAL_LIFECYCLE_OPERATION_STATUSES),
        ),
      )
      .orderBy(asc(capsuleLifecycleOperationsTable.createdAt))
  }

  public async listAbandonedDestroyOperationCandidates(): Promise<AbandonedDestroyLifecycleOperationCandidate[]> {
    return await this.db
      .select({
        id: capsuleLifecycleOperationsTable.id,
        capsuleId: capsuleLifecycleOperationsTable.capsuleId,
        ownerId: capsuleLifecycleOperationsTable.ownerId,
        status: capsuleLifecycleOperationsTable.status,
        createdAt: capsuleLifecycleOperationsTable.createdAt,
        updatedAt: capsuleLifecycleOperationsTable.updatedAt,
      })
      .from(capsuleLifecycleOperationsTable)
      .where(
        and(
          eq(capsuleLifecycleOperationsTable.type, CapsuleLifecycleOperationType.DESTROY),
          inArray(capsuleLifecycleOperationsTable.status, NON_TERMINAL_LIFECYCLE_OPERATION_STATUSES),
        ),
      )
      .orderBy(asc(capsuleLifecycleOperationsTable.createdAt))
  }

  public async markAbandonedLifecycleOperationCleanupRequired(
    ownerId: string,
    capsuleId: string,
    operationId: string,
    error: unknown,
    context?: Record<string, unknown>,
  ): Promise<boolean> {
    return await this.markLifecycleOperationAndAggregateCleanupRequired(ownerId, capsuleId, operationId, error, context)
  }

  public async markLifecycleOperationAndAggregateCleanupRequired(
    ownerId: string,
    capsuleId: string,
    operationId: string,
    error: unknown,
    context?: Record<string, unknown>,
  ): Promise<boolean> {
    const details = createFailureDetails(error, context)
    return await this.db.transaction(async tx => {
      const [capsule] = await tx
        .select({
          id: capsulesTable.id,
          lifecycleStatus: capsulesTable.lifecycleStatus,
        })
        .from(capsulesTable)
        .where(and(eq(capsulesTable.id, capsuleId), eq(capsulesTable.ownerId, ownerId)))
        .for('update')
        .limit(1)
      if (!capsule) {
        return false
      }
      await tx
        .select({
          id: capsuleBranchesTable.id,
        })
        .from(capsuleBranchesTable)
        .where(eq(capsuleBranchesTable.capsuleId, capsuleId))
        .orderBy(asc(capsuleBranchesTable.id))
        .for('update')
      const now = new Date()
      const operations = await tx
        .update(capsuleLifecycleOperationsTable)
        .set({
          status: CapsuleLifecycleOperationStatus.CLEANUP_REQUIRED,
          failedAt: now,
          updatedAt: now,
          failureCode: failureCodeFromUnknown(error),
          failureMessage: failureMessageFromUnknown(error, 'Capsule lifecycle operation requires cleanup.'),
          failureDetails: details === undefined ? undefined : toJsonObject(details, 'capsule lifecycle operation failure details'),
        })
        .where(
          and(
            eq(capsuleLifecycleOperationsTable.id, operationId),
            eq(capsuleLifecycleOperationsTable.ownerId, ownerId),
            eq(capsuleLifecycleOperationsTable.capsuleId, capsuleId),
            inArray(capsuleLifecycleOperationsTable.status, NON_TERMINAL_LIFECYCLE_OPERATION_STATUSES),
          ),
        )
        .returning({
          id: capsuleLifecycleOperationsTable.id,
        })
      if (operations.length === 0) {
        return false
      }
      if (capsule.lifecycleStatus !== 'destroyed') {
        await tx
          .update(capsulesTable)
          .set({
            lifecycleStatus: 'cleanup_required',
            updatedAt: now,
          })
          .where(and(eq(capsulesTable.id, capsuleId), eq(capsulesTable.ownerId, ownerId)))
      }
      await tx
        .update(capsuleBranchesTable)
        .set({
          status: 'cleanup_required',
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleBranchesTable.capsuleId, capsuleId),
            inArray(capsuleBranchesTable.status, ['provisioning', 'offline', 'starting', 'online', 'stopping', 'destroying', 'error']),
          ),
        )
      return true
    })
  }

  public async transitionLifecycleOperationStatus(operationId: string, status: CapsuleLifecycleOperationStatusValue): Promise<void> {
    const now = new Date()
    const updateData: {
      status: CapsuleLifecycleOperationStatusValue
      updatedAt: Date
      completedAt?: Date
      failedAt?: Date
    } = {
      status,
      updatedAt: now,
    }
    if (status === CapsuleLifecycleOperationStatus.COMPLETED) {
      updateData.completedAt = now
    }
    if (status === CapsuleLifecycleOperationStatus.FAILED || status === CapsuleLifecycleOperationStatus.CLEANUP_REQUIRED) {
      updateData.failedAt = now
    }
    const transitioned = await this.db
      .update(capsuleLifecycleOperationsTable)
      .set(updateData)
      .where(eq(capsuleLifecycleOperationsTable.id, operationId))
      .returning({
        id: capsuleLifecycleOperationsTable.id,
      })
    if (transitioned.length !== 1) {
      throw new IncusError('Capsule lifecycle operation was not found while changing its status.', 'NOT_FOUND', {
        operationId,
        status,
      })
    }
  }

  public async markLifecycleOperationFailure(
    operationId: string,
    status: CapsuleLifecycleOperationStatusValue,
    error: unknown,
    context?: Record<string, unknown>,
  ): Promise<void> {
    const now = new Date()
    const details = createFailureDetails(error, context)
    const transitioned = await this.db
      .update(capsuleLifecycleOperationsTable)
      .set({
        status,
        failedAt: now,
        updatedAt: now,
        failureCode: failureCodeFromUnknown(error),
        failureMessage: failureMessageFromUnknown(error, 'Unknown capsule lifecycle operation failure.'),
        failureDetails: details === undefined ? undefined : toJsonObject(details, 'capsule lifecycle operation failure details'),
      })
      .where(eq(capsuleLifecycleOperationsTable.id, operationId))
      .returning({
        id: capsuleLifecycleOperationsTable.id,
      })
    if (transitioned.length !== 1) {
      throw new IncusError('Failed to persist capsule lifecycle operation failure.', 'NOT_FOUND', {
        operationId,
        status,
      })
    }
  }

  public createBootstrapOutput(
    operationId: string,
    capsuleId: string,
    operationStatus: CapsuleLifecycleOperationStatusValue,
    bootstrapBranchName: string,
    branchStatus: Parameters<typeof CapsuleBootstrapCreateOutputSchema.parse>[0] extends never ? never : string,
    replayed: boolean,
  ): CapsuleBootstrapCreateOutput {
    return CapsuleBootstrapCreateOutputSchema.parse({
      capsuleId,
      operationId,
      operationType: CapsuleLifecycleOperationType.BOOTSTRAP,
      operationStatus,
      bootstrapBranchName,
      branchStatus,
      replayed,
    })
  }

  private async findExistingLifecycleReceipt(
    ownerId: string,
    idempotencyKey: string,
    requestHash: string,
    expectedType: 'archive' | 'unarchive' | 'destroy',
  ): Promise<CapsuleLifecycleReceiptRecord | null> {
    const operation = await this.findOperationByOwnerIdempotencyKey(ownerId, idempotencyKey)
    if (!operation) {
      return null
    }
    this.assertIdempotentOperation(operation.type, operation.requestHash, expectedType, requestHash, idempotencyKey)
    const [capsule] = await this.db
      .select({
        lifecycleStatus: capsulesTable.lifecycleStatus,
        archivedAt: capsulesTable.archivedAt,
        destroyedAt: capsulesTable.destroyedAt,
      })
      .from(capsulesTable)
      .where(and(eq(capsulesTable.id, operation.capsuleId), eq(capsulesTable.ownerId, ownerId)))
      .limit(1)
    if (!capsule) {
      throw new IncusError('Lifecycle operation references a missing capsule aggregate.', 'API_ERROR', {
        operationId: operation.id,
        capsuleId: operation.capsuleId,
      })
    }
    return {
      operationId: operation.id,
      operationType: expectedType,
      operationStatus: operation.status,
      capsuleId: operation.capsuleId,
      lifecycleStatus: capsule.lifecycleStatus,
      archivedAt: capsule.archivedAt,
      destroyedAt: capsule.destroyedAt,
      replayed: true,
    }
  }

  private async findOperationByOwnerIdempotencyKey(ownerId: string, idempotencyKey: string) {
    return await this.db.query.capsuleLifecycleOperations.findFirst({
      where: {
        ownerId,
        idempotencyKey,
      },
      columns: {
        id: true,
        capsuleId: true,
        type: true,
        status: true,
        requestHash: true,
        branchId: true,
        branchName: true,
      },
    })
  }

  private async findOperationBranch(ownerId: string, branchId: string | null) {
    if (!branchId) {
      return null
    }
    const [branch] = await this.db
      .select({
        status: capsuleBranchesTable.status,
      })
      .from(capsuleBranchesTable)
      .where(and(eq(capsuleBranchesTable.id, branchId), eq(capsuleBranchesTable.ownerId, ownerId)))
      .limit(1)
    return branch ?? null
  }

  private assertIdempotentOperation(
    actualType: CapsuleLifecycleOperationTypeValue,
    actualHash: string,
    expectedType: CapsuleLifecycleOperationTypeValue,
    expectedHash: string,
    idempotencyKey: string,
  ): void {
    if (actualType !== expectedType) {
      throw new IncusError('Idempotency key was already used with a different capsule lifecycle operation type.', 'CONFLICT', {
        idempotencyKey,
        existingOperationType: actualType,
        requestedOperationType: expectedType,
      })
    }
    if (actualHash !== expectedHash) {
      throw new IncusError('Idempotency key was already used with different capsule lifecycle input.', 'CONFLICT', {
        idempotencyKey,
        operationType: expectedType,
      })
    }
  }

  private assertArchiveBranchState(
    capsuleId: string,
    branches: readonly {
      id: string
      status: string
      isRootBranch: boolean
    }[],
  ): void {
    const rootBranchCount = branches.filter(branch => branch.isRootBranch).length
    if (branches.length === 0 || rootBranchCount !== 1) {
      throw new IncusError('Capsule branch lineage is incomplete. Archive requires exactly one root branch.', 'CONFLICT', {
        capsuleId,
        branchCount: branches.length,
        rootBranchCount,
      })
    }
    const nonOffline = branches.filter(branch => branch.status !== 'offline')
    if (nonOffline.length > 0) {
      throw new IncusError('Every capsule branch must be offline before the capsule can be archived.', 'CONFLICT', {
        capsuleId,
        branches: nonOffline.map(branch => ({
          branchId: branch.id,
          status: branch.status,
        })),
      })
    }
  }

  private assertDestroyBranchState(capsuleId: string, branches: readonly DestroyingCapsuleBranch[]): void {
    this.assertArchiveBranchState(capsuleId, branches)
    const foreignCapsule = branches.find(branch => branch.capsuleId !== capsuleId)
    if (foreignCapsule) {
      throw new IncusError('Capsule branch identity does not match the destroy subject.', 'CONFLICT', {
        capsuleId,
        branchId: foreignCapsule.id,
        recordedCapsuleId: foreignCapsule.capsuleId,
      })
    }
  }

  private toProtocolLifecycleReceipt(receipt: CapsuleLifecycleReceiptRecord) {
    return {
      operationId: receipt.operationId,
      operationType: receipt.operationType,
      operationStatus: receipt.operationStatus,
      capsuleId: receipt.capsuleId,
      lifecycleStatus: receipt.lifecycleStatus,
      archivedAt: toIsoTimestamp(receipt.archivedAt),
      destroyedAt: toIsoTimestamp(receipt.destroyedAt),
      replayed: receipt.replayed,
    }
  }

  private fallbackBootstrapBranchStatus(operationStatus: CapsuleLifecycleOperationStatusValue) {
    switch (operationStatus) {
      case CapsuleLifecycleOperationStatus.COMPLETED:
        return 'offline' as const
      case CapsuleLifecycleOperationStatus.CLEANUP_REQUIRED:
        return 'cleanup_required' as const
      case CapsuleLifecycleOperationStatus.FAILED:
        return 'error' as const
      case CapsuleLifecycleOperationStatus.ACCEPTED:
      case CapsuleLifecycleOperationStatus.RUNNING:
      default:
        return 'provisioning' as const
    }
  }
}
