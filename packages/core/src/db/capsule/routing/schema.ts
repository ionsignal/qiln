import type { PgColumn } from 'drizzle-orm/pg-core'
import { createCapsuleRouteAliasesTable, createCapsuleRouteHeadsTable } from './alias'
import { createCapsuleRouteOperationsTable } from './operation'
import { createCapsuleRouteProviderApplicationsTable } from './provider'
import { createCapsuleRouteRevisionsTable } from './revision'

/**
 * Creates the routing persistence fragment using the exact capsule-domain
 * columns supplied by the public capsule composition root.
 */
export function createSchema(
  ownerIdColumn: PgColumn,
  capsuleIdColumn: PgColumn,
  operationIdColumn: PgColumn,
  snapshotIdColumn: PgColumn,
) {
  const capsuleRouteAliases = createCapsuleRouteAliasesTable(ownerIdColumn, capsuleIdColumn, operationIdColumn)
  const capsuleRouteRevisions = createCapsuleRouteRevisionsTable(
    capsuleRouteAliases.id,
    snapshotIdColumn,
    operationIdColumn,
  )
  const capsuleRouteHeads = createCapsuleRouteHeadsTable(
    capsuleRouteAliases.id,
    capsuleRouteRevisions.id,
    capsuleRouteRevisions.aliasId,
  )
  const capsuleRouteOperations = createCapsuleRouteOperationsTable(
    operationIdColumn,
    capsuleRouteAliases.id,
    capsuleRouteRevisions.id,
    capsuleRouteRevisions.aliasId,
    capsuleRouteRevisions.operationId,
  )
  const capsuleRouteProviderApplications = createCapsuleRouteProviderApplicationsTable(
    operationIdColumn,
    capsuleRouteRevisions.id,
    capsuleRouteRevisions.operationId,
  )

  return {
    capsuleRouteAliases,
    capsuleRouteHeads,
    capsuleRouteRevisions,
    capsuleRouteOperations,
    capsuleRouteProviderApplications,
  }
}

export type Tables = ReturnType<typeof createSchema>
