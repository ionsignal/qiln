import { and, eq, isNull } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  capsuleOperationsTable,
  type CapsuleActorReference,
  type CapsuleHostDbContract,
  type CapsuleOperationRequestHash,
} from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import { assertOperationReplayIdentity } from '../../shared/replayIdentity'
import { toCapsuleOperationTransition } from '../../shared/operationTransition'
import type { CapsuleOperationReader } from '../../shared/operationReader'
import type { CapsuleOperationTransitionOutput, PersistedCapsuleOperation } from '../../shared/types'

export type ProviderFreeArchivalOperationType =
  typeof CapsuleOperationType.ARCHIVE | typeof CapsuleOperationType.UNARCHIVE

export interface FindProviderFreeArchivalReplayInput {
  ownerId: string
  actor: CapsuleActorReference
  idempotencyKey: string
  requestHash: CapsuleOperationRequestHash
  operationType: ProviderFreeArchivalOperationType
  requestDescription: string
}

export interface LoadAcceptedProviderFreeArchivalOperationInput {
  operationId: string
  operationType: ProviderFreeArchivalOperationType
  operationDescription: string
}

export interface ClaimProviderFreeArchivalOperationInput {
  operationId: string
  operationType: ProviderFreeArchivalOperationType
  operationDescription: string
}

/**
 * Mechanical access to the shared operation ledger for provider-free archive
 * and unarchive operations.
 *
 * This component validates base-operation identity and performs the common
 * accepted-to-running compare-and-set. It does not decide capsule lifecycle
 * eligibility, archive timestamp policy, terminal failure classification, or
 * abandoned-operation policy.
 */
export class ProviderFreeArchivalOperationLedger {
  constructor(
    private readonly db: CapsuleHostDbContract,
    private readonly reader: CapsuleOperationReader,
  ) {}

  /**
   * Finds an existing submission and validates its durable idempotency
   * identity.
   *
   * This deliberately validates only operation type, actor, and request hash.
   * Receipt mapping and operation-specific durable invariants remain the
   * responsibility of the archive or unarchive repository.
   */
  public async findSubmissionReplay(
    input: FindProviderFreeArchivalReplayInput,
  ): Promise<PersistedCapsuleOperation | null> {
    const operation = await this.reader.loadByOwnerAndIdempotencyKey(input.ownerId, input.idempotencyKey)
    if (!operation) {
      return null
    }
    assertOperationReplayIdentity(operation, {
      operationType: input.operationType,
      requestHash: input.requestHash,
      requestDescription: input.requestDescription,
      actor: input.actor,
    })
    return operation
  }

  /**
   * Reloads and validates the common durable execution shape for a newly
   * accepted provider-free archival operation.
   *
   * Archive and unarchive executors receive only the operation ID. They cannot
   * use the original command payload as execution input.
   */
  public async loadAcceptedExecution(
    input: LoadAcceptedProviderFreeArchivalOperationInput,
  ): Promise<PersistedCapsuleOperation> {
    const operation = await this.reader.loadById(input.operationId)
    if (!operation) {
      throw new IncusError(`${input.operationDescription} operation was not found.`, 'NOT_FOUND', {
        operationId: input.operationId,
      })
    }
    if (operation.type !== input.operationType) {
      throw new IncusError(`Operation is not a ${input.operationDescription} operation.`, 'CONFLICT', {
        operationId: input.operationId,
        expectedOperationType: input.operationType,
        actualOperationType: operation.type,
      })
    }
    if (operation.status !== CapsuleOperationStatus.ACCEPTED) {
      throw new IncusError(`${input.operationDescription} operation is no longer accepted for execution.`, 'CONFLICT', {
        operationId: input.operationId,
        operationStatus: operation.status,
      })
    }
    if (operation.providerMutationStartedAt !== null) {
      throw new IncusError(
        `${input.operationDescription} operation unexpectedly contains provider intent.`,
        'CONFLICT',
        {
          operationId: input.operationId,
          providerMutationStartedAt: operation.providerMutationStartedAt.toISOString(),
        },
      )
    }
    return operation
  }

  /**
   * Claims one accepted provider-free archival operation for process-local
   * execution.
   *
   * Absence of provider intent is part of the update fence so contradictory
   * durable evidence cannot transition into `running`.
   */
  public async claimAccepted(
    input: ClaimProviderFreeArchivalOperationInput,
  ): Promise<CapsuleOperationTransitionOutput> {
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
          eq(capsuleOperationsTable.id, input.operationId),
          eq(capsuleOperationsTable.type, input.operationType),
          eq(capsuleOperationsTable.status, CapsuleOperationStatus.ACCEPTED),
          isNull(capsuleOperationsTable.providerMutationStartedAt),
        ),
      )
      .returning({
        ownerId: capsuleOperationsTable.ownerId,
        capsuleId: capsuleOperationsTable.capsuleId,
        operationStatus: capsuleOperationsTable.status,
      })
    if (!claimed) {
      throw new IncusError(
        `${input.operationDescription} operation could not be claimed from accepted to running.`,
        'CONFLICT',
        {
          operationId: input.operationId,
          operationType: input.operationType,
        },
      )
    }
    return toCapsuleOperationTransition({
      ownerId: claimed.ownerId,
      operationId: input.operationId,
      operationType: input.operationType,
      operationStatus: claimed.operationStatus,
      capsuleId: claimed.capsuleId,
    })
  }
}
