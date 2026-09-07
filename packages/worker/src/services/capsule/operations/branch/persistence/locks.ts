import { and, eq } from 'drizzle-orm'
import type { CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError } from '../../../../../errors'
import type { BranchCapsuleRow, BranchOperationRow, BranchOperationType, LockedBranchOperation } from '../types'

export type BranchTransaction<TDatabase extends PostgresJsDatabase> = Parameters<
  Parameters<TDatabase['transaction']>[0]
>[0]

type DiscoveredOperation = Pick<BranchOperationRow, 'id' | 'ownerId' | 'capsuleId' | 'type'>

/**
 * Existing-operation transactions lock:
 *
 * Capsule → operation → extension → branch.
 *
 * The initial operation read discovers its parent only. Parent attribution and
 * operation identity are checked again after acquiring the canonical locks.
 */
export class BranchLocks<
  TOperation extends BranchOperationType,
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    public readonly type: TOperation,
  ) {}

  public async capsule(tx: BranchTransaction<TDatabase>, ownerId: string, capsuleId: string) {
    const capsules = this.persistence.tables.capsules
    const [capsule] = await tx
      .select()
      .from(capsules)
      .where(and(eq(capsules.id, capsuleId), eq(capsules.ownerId, ownerId)))
      .for('update')
      .limit(1)
    if (!capsule) {
      throw new IncusError('Capsule not found or access denied.', 'NOT_FOUND', {
        capsuleId,
      })
    }
    return capsule
  }

  public async branch(tx: BranchTransaction<TDatabase>, branchId: string) {
    const branches = this.persistence.tables.capsuleBranches
    const [branch] = await tx.select().from(branches).where(eq(branches.id, branchId)).for('update').limit(1)
    return branch ?? null
  }

  /**
   * Called after locking the requested capsule during acceptance. This read
   * must precede mutable capsule and branch eligibility checks.
   */
  public async replay(tx: BranchTransaction<TDatabase>, ownerId: string, idempotencyKey: string) {
    const operations = this.persistence.tables.capsuleOperations
    const [operation] = await tx
      .select()
      .from(operations)
      .where(and(eq(operations.ownerId, ownerId), eq(operations.idempotencyKey, idempotencyKey)))
      .limit(1)
    return operation ?? null
  }

  public async load(tx: BranchTransaction<TDatabase>, operationId: string): Promise<LockedBranchOperation> {
    const operations = this.persistence.tables.capsuleOperations
    const [discovered] = await tx
      .select({
        id: operations.id,
        ownerId: operations.ownerId,
        capsuleId: operations.capsuleId,
        type: operations.type,
      })
      .from(operations)
      .where(eq(operations.id, operationId))
      .limit(1)
    if (!discovered) {
      throw new IncusError('Branch runtime operation was not found.', 'NOT_FOUND', {
        operationId,
      })
    }

    this.assertType(discovered)

    const capsule = await this.capsule(tx, discovered.ownerId, discovered.capsuleId)
    return await this.operation(tx, capsule, discovered)
  }

  /**
   * Accepts an already-locked capsule so the acceptance replay recheck never
   * acquires another capsule while holding the requested capsule's lock.
   *
   * Missing extension or branch rows are retained for conservative failure
   * classification. Execution and replay require full identity validation.
   */
  public async operation(
    tx: BranchTransaction<TDatabase>,
    capsule: BranchCapsuleRow,
    discovered: DiscoveredOperation,
  ): Promise<LockedBranchOperation> {
    this.assertType(discovered)

    if (discovered.capsuleId !== capsule.id || discovered.ownerId !== capsule.ownerId) {
      throw new IncusError('Branch operation discovery does not match the locked capsule.', 'CONFLICT', {
        operationId: discovered.id,
        capsuleId: capsule.id,
      })
    }
    const { capsuleOperations, capsuleBranchRuntimeOperations } = this.persistence.tables
    const [operation] = await tx
      .select()
      .from(capsuleOperations)
      .where(eq(capsuleOperations.id, discovered.id))
      .for('update')
      .limit(1)
    if (!operation) {
      throw new IncusError('Branch runtime operation disappeared before it could be locked.', 'NOT_FOUND', {
        operationId: discovered.id,
      })
    }
    if (
      operation.type !== this.type ||
      operation.ownerId !== discovered.ownerId ||
      operation.capsuleId !== discovered.capsuleId ||
      operation.ownerId !== capsule.ownerId ||
      operation.capsuleId !== capsule.id
    ) {
      throw new IncusError('Branch operation parent identity changed before locking completed.', 'CONFLICT', {
        operationId: operation.id,
        capsuleId: capsule.id,
      })
    }
    const [extension] = await tx
      .select()
      .from(capsuleBranchRuntimeOperations)
      .where(eq(capsuleBranchRuntimeOperations.operationId, operation.id))
      .for('update')
      .limit(1)
    const branch = extension ? await this.branch(tx, extension.branchId) : null
    return {
      capsule,
      operation,
      extension: extension ?? null,
      branch,
    }
  }

  private assertType(operation: DiscoveredOperation): void {
    if (operation.type === this.type) {
      return
    }
    throw new IncusError('Operation does not match this branch runtime capability.', 'CONFLICT', {
      operationId: operation.id,
      expectedOperationType: this.type,
      operationType: operation.type,
    })
  }
}
