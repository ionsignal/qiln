import { and, asc, eq } from 'drizzle-orm'
import {
  CapsuleOperationType,
  type CapsuleBranchResourceInventoryDigest,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import { IncusError } from '../../../errors'
import {
  assertCapsuleBranchResourceInventoryMatches,
  createCapsuleBranchResourceInventoryDigest,
  type CapsuleBranchResourceInventoryEntry,
} from './inventory'
import { CreateResourceLineage, type ValidatedCreateLineage } from './lineage'
import { createResourceInventoryEntries, type CreateResourcePlanner } from './plan'
import type { ProjectService } from '../../project'
import type { CreateCapsuleResourcePlan } from './types'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

type Transaction<TDatabase extends PostgresJsDatabase> = Parameters<Parameters<TDatabase['transaction']>[0]>[0]

export interface ResourceProvenanceTarget {
  ownerId: string
  capsuleId: string
  branchId: string
}

export interface CreateResourceProof {
  origin: CapsuleTables['capsuleOperations']['$inferSelect']
  lineage: ValidatedCreateLineage
  plan: CreateCapsuleResourcePlan
  inventory: Array<CapsuleBranchResourceInventoryEntry & { metadata: Record<string, unknown> }>
  expectedInventoryDigest: CapsuleBranchResourceInventoryDigest
  recordedInventoryDigest: CapsuleBranchResourceInventoryDigest | null
}

/**
 * Resolves create-owned resource reconstruction evidence without consulting
 * mutable catalogs or live provider state.
 *
 * The originating operation's provider intent is returned independently from
 * any later destroy operation. A destroy fence cannot establish whether the
 * originating create attempted provider work.
 *
 * This boundary proves immutable lineage and reconstructs the expected plan. It
 * does not assess resource accounting states, repair inventory, authorize
 * deletion, or decide capsule lifecycle eligibility.
 *
 * Fork reconstruction is intentionally unsupported until its own immutable
 * planning and provenance rules are integrated.
 */
export class CapsuleResourceProvenance<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  private readonly lineage = new CreateResourceLineage()

  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly planner: CreateResourcePlanner,
    private readonly projects: ProjectService,
  ) {}

  /**
   * Standalone reads release their locks before returning. Mutation callers
   * must use lock() inside the transaction that assesses or changes inventory.
   */
  public async load(target: ResourceProvenanceTarget): Promise<CreateResourceProof> {
    return await this.persistence.db.transaction(async tx => {
      return await this.lock(tx, target)
    })
  }

  /**
   * Acquires the capsule before descendant evidence and reconstructs the create
   * plan from locked durable input.
   *
   * Failed and interrupted creates remain valid provenance candidates. Their
   * status, execution timestamps, provider intent, and failure evidence must be
   * assessed by the consuming operation rather than requiring completed
   * creation here.
   */
  public async lock(tx: Transaction<TDatabase>, target: ResourceProvenanceTarget): Promise<CreateResourceProof> {
    const { capsules, capsuleBranches, capsuleOperations, capsuleCreateOperations, capsuleForkOperations } =
      this.persistence.tables
    const [capsule] = await tx
      .select({
        id: capsules.id,
      })
      .from(capsules)
      .where(and(eq(capsules.id, target.capsuleId), eq(capsules.ownerId, target.ownerId)))
      .for('update')
      .limit(1)
    if (!capsule) {
      throw new IncusError('Capsule not found or access denied while resolving resource provenance.', 'NOT_FOUND', {
        capsuleId: target.capsuleId,
      })
    }
    const [branch] = await tx
      .select()
      .from(capsuleBranches)
      .where(
        and(
          eq(capsuleBranches.id, target.branchId),
          eq(capsuleBranches.ownerId, target.ownerId),
          eq(capsuleBranches.capsuleId, capsule.id),
        ),
      )
      .for('update')
      .limit(1)
    if (!branch) {
      throw new IncusError(
        'Capsule branch not found or access denied while resolving resource provenance.',
        'NOT_FOUND',
        {
          capsuleId: target.capsuleId,
          branchId: target.branchId,
        },
      )
    }
    if (!branch.isRootBranch) {
      throw new IncusError('Resource reconstruction currently supports create-owned root branches only.', 'CONFLICT', {
        capsuleId: capsule.id,
        branchId: branch.id,
      })
    }
    const creates = await tx
      .select()
      .from(capsuleCreateOperations)
      .where(eq(capsuleCreateOperations.rootBranchId, branch.id))
      .limit(2)
      .for('update')
    const forks = await tx
      .select({
        operationId: capsuleForkOperations.operationId,
      })
      .from(capsuleForkOperations)
      .where(eq(capsuleForkOperations.targetBranchId, branch.id))
      .limit(1)
      .for('update')
    if (creates.length !== 1 || forks.length !== 0) {
      throw new IncusError('Root branch does not have exactly one unambiguous create provenance record.', 'CONFLICT', {
        capsuleId: capsule.id,
        branchId: branch.id,
      })
    }
    const extension = creates[0]!
    const [origin] = await tx
      .select()
      .from(capsuleOperations)
      .where(
        and(
          eq(capsuleOperations.id, extension.operationId),
          eq(capsuleOperations.ownerId, target.ownerId),
          eq(capsuleOperations.capsuleId, capsule.id),
        ),
      )
      .for('update')
      .limit(1)
    if (!origin || origin.type !== CapsuleOperationType.CREATE) {
      throw new IncusError('Resource provenance does not resolve an owned create operation.', 'CONFLICT', {
        capsuleId: capsule.id,
        branchId: branch.id,
        operationId: extension.operationId,
      })
    }
    const roots = await tx
      .select()
      .from(capsuleBranches)
      .where(and(eq(capsuleBranches.capsuleId, capsule.id), eq(capsuleBranches.isRootBranch, true)))
      .orderBy(asc(capsuleBranches.id))
      .for('update')
    const lineage = this.lineage.validate(origin, extension, roots)
    const plan = this.planner.plan({
      namespace: this.projects.getNamespace(origin.ownerId),
      rootBranchId: lineage.rootBranch.id,
      rootBranchName: lineage.extension.rootBranchName,
      cpu: lineage.extension.cpu,
      memory: lineage.extension.memory,
      blueprint: lineage.blueprint,
      rootfsImagePin: lineage.rootfsImagePin,
    })
    const inventory = createResourceInventoryEntries(plan)
    const recordedInventoryDigest = lineage.rootBranch.resourceInventoryDigest
    const expectedInventoryDigest =
      recordedInventoryDigest === null
        ? createCapsuleBranchResourceInventoryDigest(inventory, 'capsule create reconstructed resource inventory')
        : assertCapsuleBranchResourceInventoryMatches(recordedInventoryDigest, inventory)
    return {
      origin,
      lineage,
      plan,
      inventory,
      expectedInventoryDigest,
      recordedInventoryDigest,
    }
  }
}
