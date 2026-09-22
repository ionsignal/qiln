import { and, asc, eq, inArray, or } from 'drizzle-orm'
import type { CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError } from '../../../errors'
import type { BranchRow, CapsuleReadScope, CapsuleRow, OperationRow, PreviewRow, ReadTransaction } from './types'

/**
 * Dashboard reads share one statement snapshot across their batched queries and
 * historical provenance reads without blocking capsule mutations.
 */
export class CapsuleReadStore<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(private readonly persistence: CapsulePersistence<TDatabase, TTables>) {}

  public async read<TResult>(action: (tx: ReadTransaction<TDatabase>) => Promise<TResult>): Promise<TResult> {
    return await this.persistence.db.transaction(action, {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    })
  }

  public async list(tx: ReadTransaction<TDatabase>, ownerId: string): Promise<CapsuleReadScope[]> {
    const tables = this.persistence.tables
    const capsules = await tx
      .select()
      .from(tables.capsules)
      .where(eq(tables.capsules.ownerId, ownerId))
      .orderBy(asc(tables.capsules.createdAt), asc(tables.capsules.id))
    if (capsules.length === 0) {
      return []
    }
    const capsuleIds = capsules.map(capsule => capsule.id)
    const branches = await tx
      .select()
      .from(tables.capsuleBranches)
      .where(and(inArray(tables.capsuleBranches.capsuleId, capsuleIds), eq(tables.capsuleBranches.isRootBranch, true)))
      .orderBy(asc(tables.capsuleBranches.id))
    const roots = this.group(branches, branch => branch.capsuleId)
    const operations = this.group(await this.operations(tx, capsuleIds), operation => operation.capsuleId)
    const previews = this.group(
      await this.previews(
        tx,
        branches.map(branch => branch.id),
      ),
      preview => preview.branchId,
    )
    return capsules.map(capsule => {
      const root = this.root(capsule, roots.get(capsule.id) ?? [])
      return this.scope(capsule, root, root, operations.get(capsule.id) ?? [], previews.get(root.id) ?? [])
    })
  }

  public async detail(
    tx: ReadTransaction<TDatabase>,
    ownerId: string,
    capsuleId: string,
    branchId?: string,
  ): Promise<CapsuleReadScope> {
    const tables = this.persistence.tables
    const [capsule] = await tx
      .select()
      .from(tables.capsules)
      .where(and(eq(tables.capsules.id, capsuleId), eq(tables.capsules.ownerId, ownerId)))
      .limit(1)
    if (!capsule) {
      throw new IncusError('Capsule not found or access denied.', 'NOT_FOUND', {
        capsuleId,
      })
    }
    const branches = await tx
      .select()
      .from(tables.capsuleBranches)
      .where(
        and(
          eq(tables.capsuleBranches.capsuleId, capsule.id),
          branchId === undefined
            ? eq(tables.capsuleBranches.isRootBranch, true)
            : or(eq(tables.capsuleBranches.isRootBranch, true), eq(tables.capsuleBranches.id, branchId)),
        ),
      )
      .orderBy(asc(tables.capsuleBranches.id))
    const root = this.root(
      capsule,
      branches.filter(branch => branch.isRootBranch),
    )
    const branch = branchId === undefined ? root : branches.find(candidate => candidate.id === branchId)
    if (!branch || branch.ownerId !== ownerId) {
      throw new IncusError('Capsule branch not found or access denied.', 'NOT_FOUND', {
        capsuleId,
        branchId,
      })
    }
    const operations = await this.operations(tx, [capsule.id])
    const previews = await this.previews(tx, [branch.id])
    return this.scope(capsule, root, branch, operations, previews)
  }

  /**
   * Incomplete creation is an expected manifest limitation, not an empty
   * Blueprint. Missing or inconsistent origin rows are classified separately.
   */
  public async creationPending(tx: ReadTransaction<TDatabase>, branch: BranchRow): Promise<boolean> {
    if (!branch.isRootBranch) {
      return false
    }
    const { capsuleCreateOperations, capsuleOperations } = this.persistence.tables
    const rows = await tx
      .select({
        operation: capsuleOperations,
      })
      .from(capsuleCreateOperations)
      .leftJoin(capsuleOperations, eq(capsuleOperations.id, capsuleCreateOperations.operationId))
      .where(eq(capsuleCreateOperations.rootBranchId, branch.id))
      .limit(2)
    const operation = rows.length === 1 ? rows[0]!.operation : null
    return (
      operation !== null &&
      operation.type === 'create' &&
      operation.ownerId === branch.ownerId &&
      operation.capsuleId === branch.capsuleId &&
      operation.status !== 'completed' &&
      operation.completedAt === null
    )
  }

  private async operations(tx: ReadTransaction<TDatabase>, capsuleIds: string[]): Promise<OperationRow[]> {
    const operations = this.persistence.tables.capsuleOperations
    return await tx
      .select()
      .from(operations)
      .where(and(inArray(operations.capsuleId, capsuleIds), inArray(operations.status, ['accepted', 'running'])))
      .orderBy(asc(operations.acceptedAt), asc(operations.id))
  }

  private async previews(tx: ReadTransaction<TDatabase>, branchIds: string[]): Promise<PreviewRow[]> {
    if (branchIds.length === 0) {
      return []
    }
    const previews = this.persistence.tables.capsuleBranchPreviews
    return await tx
      .select()
      .from(previews)
      .where(inArray(previews.branchId, branchIds))
      .orderBy(asc(previews.applicationName), asc(previews.id))
  }

  private root(capsule: CapsuleRow, branches: BranchRow[]): BranchRow {
    if (branches.length !== 1) {
      throw new IncusError('Capsule must have exactly one durable root branch.', 'CONFLICT', {
        capsuleId: capsule.id,
        rootCount: branches.length,
      })
    }
    const root = branches[0]!
    this.assertBranch(capsule, root)
    return root
  }

  private scope(
    capsule: CapsuleRow,
    root: BranchRow,
    branch: BranchRow,
    operations: OperationRow[],
    previews: PreviewRow[],
  ): CapsuleReadScope {
    this.assertBranch(capsule, branch)
    if (operations.length > 1) {
      throw new IncusError('Capsule has multiple nonterminal operations.', 'CONFLICT', {
        capsuleId: capsule.id,
      })
    }
    const operation = operations[0] ?? null
    if (operation && (operation.ownerId !== capsule.ownerId || operation.capsuleId !== capsule.id)) {
      throw new IncusError('Current operation does not match capsule ownership.', 'CONFLICT', {
        capsuleId: capsule.id,
        operationId: operation.id,
      })
    }
    for (const preview of previews) {
      if (preview.ownerId !== capsule.ownerId || preview.capsuleId !== capsule.id || preview.branchId !== branch.id) {
        throw new IncusError('Preview does not match its capsule and selected branch.', 'CONFLICT', {
          capsuleId: capsule.id,
          branchId: branch.id,
          previewId: preview.id,
        })
      }
    }
    return {
      capsule,
      root,
      branch,
      operation,
      previews,
    }
  }

  private assertBranch(capsule: CapsuleRow, branch: BranchRow): void {
    if (branch.ownerId !== capsule.ownerId || branch.capsuleId !== capsule.id) {
      throw new IncusError('Branch does not match capsule ownership.', 'CONFLICT', {
        capsuleId: capsule.id,
        branchId: branch.id,
      })
    }
  }

  private group<TValue>(values: TValue[], key: (value: TValue) => string): Map<string, TValue[]> {
    const groups = new Map<string, TValue[]>()
    for (const value of values) {
      const id = key(value)
      const group = groups.get(id) ?? []
      group.push(value)
      groups.set(id, group)
    }
    return groups
  }
}
