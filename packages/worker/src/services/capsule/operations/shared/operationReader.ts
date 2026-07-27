import { and, asc, eq, inArray } from 'drizzle-orm'
import {
  CapsuleActorReferenceSchema,
  CapsuleOperationReceiptSchema,
  CapsuleOperationStatus,
  type CapsulePersistence,
  type CapsuleTables,
  type CapsuleOperationReceipt,
} from '@qiln/core/server'
import type { PersistedCapsuleOperation } from './types'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

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
export class CapsuleOperationReader<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(private readonly persistence: CapsulePersistence<TDatabase, TTables>) {}

  public async loadById(operationId: string): Promise<PersistedCapsuleOperation | null> {
    const db = this.persistence.db
    const persistence = this.persistence.tables.capsuleOperations
    const [operation] = await db.select().from(persistence).where(eq(persistence.id, operationId)).limit(1)
    return operation ? this.toPersistedOperation(operation) : null
  }

  public async loadByOwnerAndIdempotencyKey(
    ownerId: string,
    idempotencyKey: string,
  ): Promise<PersistedCapsuleOperation | null> {
    const db = this.persistence.db
    const persistence = this.persistence.tables.capsuleOperations
    const [operation] = await db
      .select()
      .from(persistence)
      .where(and(eq(persistence.ownerId, ownerId), eq(persistence.idempotencyKey, idempotencyKey)))
      .limit(1)
    return operation ? this.toPersistedOperation(operation) : null
  }

  public async listNonterminal(): Promise<PersistedCapsuleOperation[]> {
    const db = this.persistence.db
    const persistence = this.persistence.tables.capsuleOperations
    const operations = await db
      .select()
      .from(persistence)
      .where(inArray(persistence.status, NONTERMINAL_OPERATION_STATUSES))
      .orderBy(asc(persistence.acceptedAt), asc(persistence.id))
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

  private toPersistedOperation(
    operation: CapsuleTables['capsuleOperations']['$inferSelect'],
  ): PersistedCapsuleOperation {
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
