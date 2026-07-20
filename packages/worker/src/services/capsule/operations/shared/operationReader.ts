import { and, asc, eq, inArray } from 'drizzle-orm'
import {
  CapsuleActorReferenceSchema,
  CapsuleOperationReceiptSchema,
  CapsuleOperationStatus,
  capsuleOperationsTable,
  type CapsuleHostDbContract,
  type CapsuleOperationReceipt,
} from '@qiln/core/server'
import type { PersistedCapsuleOperation } from './types'

const NONTERMINAL_OPERATION_STATUSES = [CapsuleOperationStatus.ACCEPTED, CapsuleOperationStatus.RUNNING] as const

/**
 * Generic read-only access to durable capsule operations.
 *
 * This reader intentionally loads only base-ledger fields that are meaningful
 * across every operation type. Operation-specific repositories are responsible
 * for joining and validating their extension rows.
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

  private toPersistedOperation(operation: typeof capsuleOperationsTable.$inferSelect): PersistedCapsuleOperation {
    return {
      id: operation.id,
      ownerId: operation.ownerId,
      actor: CapsuleActorReferenceSchema.parse({
        type: operation.actorType,
        id: operation.actorId,
      }),
      capsuleId: operation.capsuleId,
      type: operation.type,
      status: operation.status,
      idempotencyKey: operation.idempotencyKey,
      requestHash: operation.requestHash,
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
