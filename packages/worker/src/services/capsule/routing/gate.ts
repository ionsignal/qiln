import { asc, eq, inArray } from 'drizzle-orm'
import { IncusError } from '../../../errors'
import type { CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

type Transaction<TDatabase extends PostgresJsDatabase> = Parameters<Parameters<TDatabase['transaction']>[0]>[0]

/**
 * Destroy cannot withdraw committed routes or resolve ambiguous route history.
 *
 * Callers hold the capsule lock before entering this gate. Alias rows are
 * locked separately from nullable evidence reads, avoiding PostgreSQL's outer
 * join row-lock restriction.
 */
export class RouteGate<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(private readonly persistence: CapsulePersistence<TDatabase, TTables>) {}

  public async assertDestroyable(
    tx: Transaction<TDatabase>,
    ownerId: string,
    capsuleId: string,
  ): Promise<string[]> {
    const {
      capsuleRouteAliases: aliases,
      capsuleRouteHeads: heads,
      capsuleRouteRevisions: revisions,
      capsuleRouteOperations: operations,
    } = this.persistence.tables
    const rows = await tx
      .select()
      .from(aliases)
      .where(eq(aliases.capsuleId, capsuleId))
      .orderBy(asc(aliases.id))
      .for('update')
    if (
      rows.some(
        alias =>
          alias.ownerId !== ownerId ||
          (alias.status !== 'inactive' && alias.status !== 'retired') ||
          alias.mutationOperationId !== null,
      )
    ) {
      throw new IncusError('Destroy is blocked by inconsistent or unresolved route aliases.', 'CONFLICT')
    }
    const ids = rows.map(alias => alias.id)
    if (ids.length === 0) {
      return ids
    }
    const headRows = await tx
      .select({ id: heads.aliasId })
      .from(heads)
      .where(inArray(heads.aliasId, ids))
      .limit(1)
    const revisionRows = await tx
      .select({ id: revisions.id })
      .from(revisions)
      .where(inArray(revisions.aliasId, ids))
      .limit(1)
    const operationRows = await tx
      .select({ id: operations.operationId })
      .from(operations)
      .where(inArray(operations.aliasId, ids))
      .limit(1)
    // Provider accounting references a revision through enforced foreign keys.
    // A revision therefore blocks destruction even without a route head.
    if (headRows.length > 0 || revisionRows.length > 0 || operationRows.length > 0) {
      throw new IncusError('Destroy is blocked by committed or unresolved route history.', 'CONFLICT')
    }
    return ids
  }
}
