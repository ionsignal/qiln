import { and, asc, eq, inArray } from 'drizzle-orm'
import {
  CapsuleOperationReceiptSchema,
  CapsuleOperationStatus,
  CapsuleOperationSummarySchema,
  capsuleOperationsTable,
  type CapsuleHostDbContract,
  type CapsuleOperationReceipt,
  type CapsuleOperationSummary,
} from '@qiln/core/server'
import { toClientSafeOperationFailure } from './operationFailure'
import { toIsoTimestamp, toNullableIsoTimestamp } from './timestamps'
import type { PersistedCapsuleOperation } from './types'

const NONTERMINAL_OPERATION_STATUSES = [CapsuleOperationStatus.ACCEPTED, CapsuleOperationStatus.RUNNING] as const

/**
 * Generic read-only access to durable capsule operations.
 *
 * This reader does not make idempotency decisions, mutate durable state,
 * classify abandoned operations, or construct operation-specific receipts.
 */
export class CapsuleOperationReader {
  constructor(private readonly db: CapsuleHostDbContract) {}

  public async loadById(operationId: string): Promise<PersistedCapsuleOperation | null> {
    const [operation] = await this.db.select().from(capsuleOperationsTable).where(eq(capsuleOperationsTable.id, operationId)).limit(1)

    return operation ? this.toPersistedOperation(operation) : null
  }

  public async loadByOwnerAndIdempotencyKey(ownerId: string, idempotencyKey: string): Promise<PersistedCapsuleOperation | null> {
    const [operation] = await this.db
      .select()
      .from(capsuleOperationsTable)
      .where(and(eq(capsuleOperationsTable.ownerId, ownerId), eq(capsuleOperationsTable.idempotencyKey, idempotencyKey)))
      .limit(1)
    return operation ? this.toPersistedOperation(operation) : null
  }

  public async listNonterminal(): Promise<PersistedCapsuleOperation[]> {
    const operations = await this.db
      .select()
      .from(capsuleOperationsTable)
      .where(inArray(capsuleOperationsTable.status, NONTERMINAL_OPERATION_STATUSES))
      .orderBy(asc(capsuleOperationsTable.acceptedAt), asc(capsuleOperationsTable.id))
    return operations.map(operation => this.toPersistedOperation(operation))
  }

  public async loadSummary(ownerId: string, operationId: string): Promise<CapsuleOperationSummary | null> {
    const [operation] = await this.db
      .select()
      .from(capsuleOperationsTable)
      .where(and(eq(capsuleOperationsTable.id, operationId), eq(capsuleOperationsTable.ownerId, ownerId)))
      .limit(1)
    return operation ? this.toClientSafeSummary(this.toPersistedOperation(operation)) : null
  }

  public async listSummariesForCapsule(ownerId: string, capsuleId: string): Promise<CapsuleOperationSummary[]> {
    const operations = await this.db
      .select()
      .from(capsuleOperationsTable)
      .where(and(eq(capsuleOperationsTable.ownerId, ownerId), eq(capsuleOperationsTable.capsuleId, capsuleId)))
      .orderBy(asc(capsuleOperationsTable.acceptedAt), asc(capsuleOperationsTable.id))
    return operations.map(operation => this.toClientSafeSummary(this.toPersistedOperation(operation)))
  }

  /**
   * Maps only generic receipt fields.
   *
   * Create, archive, unarchive, and destroy repositories remain responsible for
   * validating and constructing their operation-specific receipt schemas.
   */
  public toGenericReceipt(operation: PersistedCapsuleOperation, replayed: boolean): CapsuleOperationReceipt {
    return CapsuleOperationReceiptSchema.parse({
      operationId: operation.id,
      operationType: operation.type,
      operationStatus: operation.status,
      capsuleId: operation.capsuleId,
      replayed,
    })
  }

  public toClientSafeSummary(operation: PersistedCapsuleOperation): CapsuleOperationSummary {
    const timestampContext = {
      entity: 'capsule operation',
      entityId: operation.id,
    }
    return CapsuleOperationSummarySchema.parse({
      id: operation.id,
      capsuleId: operation.capsuleId,
      branchId: operation.branchId,
      type: operation.type,
      status: operation.status,
      acceptedAt: toIsoTimestamp(operation.acceptedAt, 'acceptedAt', timestampContext),
      executionStartedAt: toNullableIsoTimestamp(operation.executionStartedAt, 'executionStartedAt', timestampContext),
      providerMutationStartedAt: toNullableIsoTimestamp(operation.providerMutationStartedAt, 'providerMutationStartedAt', timestampContext),
      completedAt: toNullableIsoTimestamp(operation.completedAt, 'completedAt', timestampContext),
      failedAt: toNullableIsoTimestamp(operation.failedAt, 'failedAt', timestampContext),
      failure: toClientSafeOperationFailure(operation),
    })
  }

  private toPersistedOperation(operation: typeof capsuleOperationsTable.$inferSelect): PersistedCapsuleOperation {
    return {
      id: operation.id,
      ownerId: operation.ownerId,
      capsuleId: operation.capsuleId,
      branchId: operation.branchId,
      branchName: operation.branchName,
      type: operation.type,
      status: operation.status,
      idempotencyKey: operation.idempotencyKey,
      requestHash: operation.requestHash,
      blueprintName: operation.blueprintName,
      blueprintDigest: operation.blueprintDigest,
      blueprintSnapshot: operation.blueprintSnapshot,
      acceptedAt: operation.acceptedAt,
      executionStartedAt: operation.executionStartedAt,
      providerMutationStartedAt: operation.providerMutationStartedAt,
      completedAt: operation.completedAt,
      failedAt: operation.failedAt,
      failureCode: operation.failureCode,
      failureMessage: operation.failureMessage,
      failureDetails: operation.failureDetails,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
    }
  }
}
