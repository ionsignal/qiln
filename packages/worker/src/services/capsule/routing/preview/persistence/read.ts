import { and, asc, eq, inArray } from 'drizzle-orm'
import {
  CapsuleBranchPreviewListOutputSchema,
  CapsuleOperationStatus,
  verifyCapsuleRouteApplicationPin,
  type CapsuleBranchPreviewListOutput,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError } from '../../../../../errors'
import { toIsoTimestamp } from '../../../operations/shared'
import type { PreviewBranch, PreviewRecord } from '../types'

const NONTERMINAL_OPERATION_STATUSES = [CapsuleOperationStatus.ACCEPTED, CapsuleOperationStatus.RUNNING] as const

/**
 * Read-only persistence for preview projections and reconciliation candidates.
 *
 * These reads do not authorize Caddy mutation. Every preview write revalidates
 * the corresponding capsule, branch, operation fence, and preview row under
 * canonical locks.
 */
export class PreviewReadPersistence<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(private readonly persistence: CapsulePersistence<TDatabase, TTables>) {}

  public async branches(): Promise<PreviewBranch[]> {
    const { capsules, capsuleBranches, capsuleOperations } = this.persistence.tables
    const [branches, operations] = await Promise.all([
      this.persistence.db
        .select({
          id: capsuleBranches.id,
          ownerId: capsuleBranches.ownerId,
          capsuleId: capsuleBranches.capsuleId,
          name: capsuleBranches.name,
          status: capsuleBranches.status,
          runtimeIp: capsuleBranches.runtimeIp,
          lifecycleStatus: capsules.lifecycleStatus,
          archivedAt: capsules.archivedAt,
        })
        .from(capsuleBranches)
        .innerJoin(capsules, eq(capsules.id, capsuleBranches.capsuleId))
        .orderBy(asc(capsuleBranches.ownerId), asc(capsuleBranches.id)),
      this.persistence.db
        .select({
          capsuleId: capsuleOperations.capsuleId,
        })
        .from(capsuleOperations)
        .where(inArray(capsuleOperations.status, NONTERMINAL_OPERATION_STATUSES)),
    ])
    const blocked = new Set(operations.map(operation => operation.capsuleId))
    return branches.map(branch => ({
      ...branch,
      operationBlocked: blocked.has(branch.capsuleId),
    }))
  }

  public async all(): Promise<PreviewRecord[]> {
    const previews = this.persistence.tables.capsuleBranchPreviews
    return await this.persistence.db
      .select()
      .from(previews)
      .orderBy(asc(previews.ownerId), asc(previews.branchId), asc(previews.applicationName))
  }

  public async list(ownerId: string, capsuleId: string): Promise<CapsuleBranchPreviewListOutput> {
    const previews = this.persistence.tables.capsuleBranchPreviews
    const records = await this.persistence.db
      .select()
      .from(previews)
      .where(and(eq(previews.ownerId, ownerId), eq(previews.capsuleId, capsuleId)))
      .orderBy(asc(previews.createdAt), asc(previews.id))
    return CapsuleBranchPreviewListOutputSchema.parse(
      records.map(record => ({
        id: record.id,
        capsuleId: record.capsuleId,
        branchId: record.branchId,
        applicationName: record.applicationName,
        host: record.host,
        status: record.status,
        application: verifyCapsuleRouteApplicationPin(record.applicationPin),
        verifiedAt:
          record.verifiedAt === null
            ? null
            : toIsoTimestamp(record.verifiedAt, 'verifiedAt', {
                entity: 'branch preview',
                entityId: record.id,
              }),
        createdAt: toIsoTimestamp(record.createdAt, 'createdAt', {
          entity: 'branch preview',
          entityId: record.id,
        }),
        updatedAt: toIsoTimestamp(record.updatedAt, 'updatedAt', {
          entity: 'branch preview',
          entityId: record.id,
        }),
      })),
    )
  }

  public async branch(branchId: string) {
    const branches = this.persistence.tables.capsuleBranches
    const [branch] = await this.persistence.db
      .select({
        id: branches.id,
        ownerId: branches.ownerId,
        capsuleId: branches.capsuleId,
        name: branches.name,
        isRootBranch: branches.isRootBranch,
        blueprintName: branches.blueprintName,
        blueprintDigest: branches.blueprintDigest,
        cpu: branches.cpu,
        memory: branches.memory,
        resourceInventoryDigest: branches.resourceInventoryDigest,
      })
      .from(branches)
      .where(eq(branches.id, branchId))
      .limit(1)
    if (!branch) {
      throw new IncusError('Preview branch was not found.', 'NOT_FOUND', {
        branchId,
      })
    }
    return branch
  }
}
