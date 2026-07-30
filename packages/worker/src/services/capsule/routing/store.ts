import { and, asc, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import { IncusError } from '../../../errors'
import * as graph from './graph'
import type { CommittedRouteRecord, RouteGraphRow } from './types'

/**
 * Reads committed route-alias state from one PostgreSQL statement.
 *
 * The alias head remains the sole authority for selecting a committed revision.
 * The complete operation, extension, provider, and snapshot graph is loaded
 * from the same statement snapshot and validated before it can reach a
 * client-safe projection.
 */
export class CommittedRouteStore<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(private readonly persistence: CapsulePersistence<TDatabase, TTables>) {}

  public async list(ownerId: string, capsuleId: string): Promise<CommittedRouteRecord[]> {
    const db = this.persistence.db
    const {
      capsules,
      capsuleOperations,
      capsuleSnapshots,
      capsuleRouteAliases,
      capsuleRouteHeads,
      capsuleRouteRevisions,
      capsuleRouteOperations,
      capsuleRouteProviderApplications,
    } = this.persistence.tables
    const rows = await db
      .select({
        capsule: {
          id: capsules.id,
          ownerId: capsules.ownerId,
        },
        alias: {
          id: capsuleRouteAliases.id,
          ownerId: capsuleRouteAliases.ownerId,
          capsuleId: capsuleRouteAliases.capsuleId,
          name: capsuleRouteAliases.name,
          exposure: capsuleRouteAliases.exposure,
          host: capsuleRouteAliases.host,
          path: capsuleRouteAliases.path,
          methods: capsuleRouteAliases.methods,
          matcherDigest: capsuleRouteAliases.matcherDigest,
          status: capsuleRouteAliases.status,
          createdAt: capsuleRouteAliases.createdAt,
          updatedAt: capsuleRouteAliases.updatedAt,
        },
        head: {
          aliasId: capsuleRouteHeads.aliasId,
          revisionId: capsuleRouteHeads.revisionId,
        },
        revision: {
          id: capsuleRouteRevisions.id,
          aliasId: capsuleRouteRevisions.aliasId,
          number: capsuleRouteRevisions.number,
          action: capsuleRouteRevisions.action,
          previousRevisionId: capsuleRouteRevisions.previousRevisionId,
          rollbackSourceRevisionId: capsuleRouteRevisions.rollbackSourceRevisionId,
          snapshotId: capsuleRouteRevisions.snapshotId,
          targetPin: capsuleRouteRevisions.targetPin,
          evidencePin: capsuleRouteRevisions.evidencePin,
          operationId: capsuleRouteRevisions.operationId,
          status: capsuleRouteRevisions.status,
          committedAt: capsuleRouteRevisions.committedAt,
          failedAt: capsuleRouteRevisions.failedAt,
        },
        operation: {
          id: capsuleOperations.id,
          ownerId: capsuleOperations.ownerId,
          capsuleId: capsuleOperations.capsuleId,
          type: capsuleOperations.type,
          status: capsuleOperations.status,
          providerMutationStartedAt: capsuleOperations.providerMutationStartedAt,
          completedAt: capsuleOperations.completedAt,
        },
        extension: {
          operationId: capsuleRouteOperations.operationId,
          aliasId: capsuleRouteOperations.aliasId,
          action: capsuleRouteOperations.action,
          expectedRevisionId: capsuleRouteOperations.expectedRevisionId,
          proposedRevisionId: capsuleRouteOperations.proposedRevisionId,
          rollbackSourceRevisionId: capsuleRouteOperations.rollbackSourceRevisionId,
        },
        provider: {
          operationId: capsuleRouteProviderApplications.operationId,
          revisionId: capsuleRouteProviderApplications.revisionId,
          provider: capsuleRouteProviderApplications.provider,
          status: capsuleRouteProviderApplications.status,
          configurationKey: capsuleRouteProviderApplications.configurationKey,
          configurationDigest: capsuleRouteProviderApplications.configurationDigest,
          configuration: capsuleRouteProviderApplications.configuration,
          applyIntentAt: capsuleRouteProviderApplications.applyIntentAt,
          appliedAt: capsuleRouteProviderApplications.appliedAt,
          verificationIntentAt: capsuleRouteProviderApplications.verificationIntentAt,
          verificationEvidence: capsuleRouteProviderApplications.verificationEvidence,
          verifiedAt: capsuleRouteProviderApplications.verifiedAt,
          failureCode: capsuleRouteProviderApplications.failureCode,
          failureMessage: capsuleRouteProviderApplications.failureMessage,
          failureDetails: capsuleRouteProviderApplications.failureDetails,
          failureAt: capsuleRouteProviderApplications.failureAt,
        },
        snapshot: {
          id: capsuleSnapshots.id,
          capsuleId: capsuleSnapshots.capsuleId,
          blueprintSchemaVersion: capsuleSnapshots.blueprintSchemaVersion,
          blueprintName: capsuleSnapshots.blueprintName,
          blueprintDigest: capsuleSnapshots.blueprintDigest,
          blueprintPin: capsuleSnapshots.blueprintPin,
          mode: capsuleSnapshots.mode,
          limitations: capsuleSnapshots.limitations,
        },
      })
      .from(capsules)
      .leftJoin(capsuleRouteAliases, eq(capsuleRouteAliases.capsuleId, capsules.id))
      .leftJoin(capsuleRouteHeads, eq(capsuleRouteHeads.aliasId, capsuleRouteAliases.id))
      .leftJoin(capsuleRouteRevisions, eq(capsuleRouteRevisions.id, capsuleRouteHeads.revisionId))
      .leftJoin(capsuleOperations, eq(capsuleOperations.id, capsuleRouteRevisions.operationId))
      .leftJoin(capsuleRouteOperations, eq(capsuleRouteOperations.operationId, capsuleOperations.id))
      .leftJoin(
        capsuleRouteProviderApplications,
        eq(capsuleRouteProviderApplications.operationId, capsuleOperations.id),
      )
      .leftJoin(capsuleSnapshots, eq(capsuleSnapshots.id, capsuleRouteRevisions.snapshotId))
      .where(and(eq(capsules.id, capsuleId), eq(capsules.ownerId, ownerId)))
      .orderBy(asc(capsuleRouteAliases.createdAt), asc(capsuleRouteAliases.id))
    if (rows.length === 0) {
      throw new IncusError('Capsule not found.', 'NOT_FOUND', {
        capsuleId,
      })
    }
    const records: CommittedRouteRecord[] = []
    for (const row of rows) {
      if (row.alias === null) {
        if (
          row.head !== null ||
          row.revision !== null ||
          row.operation !== null ||
          row.extension !== null ||
          row.provider !== null ||
          row.snapshot !== null
        ) {
          throw new IncusError('Capsule route projection contains target state without an alias.', 'API_ERROR', {
            ownerId,
            capsuleId,
          })
        }
        continue
      }
      const projected: RouteGraphRow = {
        capsule: row.capsule,
        alias: row.alias,
        head: row.head,
        revision: row.revision,
        operation: row.operation,
        extension: row.extension,
        provider: row.provider,
        snapshot: row.snapshot,
      }
      records.push(graph.validate(projected))
    }
    return records
  }
}
