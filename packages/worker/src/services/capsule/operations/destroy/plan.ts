import { asc, eq, inArray, or } from 'drizzle-orm'
import {
  CapsuleDestroyPlanSchema,
  digestCanonicalJsonValue,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError } from '../../../../errors'
import { proveBranch } from './proof/branch'
import { branchTargets, verifyResources } from './proof/resource'
import { snapshotTargets } from './proof/snapshot'
import { routeTargets } from './proof/route'
import type { DestroyTransaction } from './persistence/locks'
import type { DestroyBranch, DestroyBranchProof, DestroyOperation, DestroyPlan } from './types'

/**
 * Builds deletion authority without invoking current create/fork planners.
 *
 * The caller holds the capsule lock and its new destroy-operation fence.
 * Missing accounting does not erase targets retained by immutable provenance.
 */
export class DestroyPlanner<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly server: string,
  ) {}

  public async build(
    tx: DestroyTransaction<TDatabase>,
    operation: DestroyOperation,
    branches: readonly DestroyBranch[],
  ): Promise<DestroyPlan> {
    const t = this.persistence.tables
    const branchIds = branches.map(branch => branch.id)
    const operations = await tx
      .select()
      .from(t.capsuleOperations)
      .where(eq(t.capsuleOperations.capsuleId, operation.capsuleId))
      .orderBy(asc(t.capsuleOperations.id))
      .for('update')
    if (
      operations.some(
        candidate =>
          candidate.ownerId !== operation.ownerId ||
          (candidate.id !== operation.id && (candidate.status === 'accepted' || candidate.status === 'running')),
      )
    ) {
      throw new IncusError('Destroy planning requires exclusive, owner-consistent capsule operation scope.', 'CONFLICT')
    }
    const operationIds = operations.map(candidate => candidate.id)
    const byOperation = new Map(operations.map(candidate => [candidate.id, candidate]))
    const creates = await tx
      .select()
      .from(t.capsuleCreateOperations)
      .where(
        or(
          inArray(t.capsuleCreateOperations.operationId, operationIds),
          inArray(t.capsuleCreateOperations.rootBranchId, branchIds),
        ),
      )
      .for('update')
    const forks = await tx
      .select()
      .from(t.capsuleForkOperations)
      .where(
        or(
          inArray(t.capsuleForkOperations.operationId, operationIds),
          inArray(t.capsuleForkOperations.targetBranchId, branchIds),
        ),
      )
      .for('update')
    const proofs = new Map<string, DestroyBranchProof>()
    for (const branch of branches) {
      proofs.set(branch.id, proveBranch(branch, byOperation, creates, forks))
    }
    if (
      creates.some(create => !proofs.has(create.rootBranchId)) ||
      forks.some(fork => !proofs.has(fork.targetBranchId))
    ) {
      throw new IncusError('Destroy origin operations reference branches outside the capsule.', 'CONFLICT')
    }
    const resources = await tx
      .select()
      .from(t.capsuleBranchResources)
      .where(
        or(
          inArray(t.capsuleBranchResources.branchId, branchIds),
          inArray(t.capsuleBranchResources.createdByOperationId, operationIds),
        ),
      )
      .orderBy(asc(t.capsuleBranchResources.id))
      .for('update')
    for (const proof of proofs.values()) {
      verifyResources(
        proof,
        resources.filter(
          resource => resource.branchId === proof.branch.id || resource.createdByOperationId === proof.origin.id,
        ),
      )
    }
    if (
      resources.some(
        resource =>
          ![...proofs.values()].some(
            proof => resource.branchId === proof.branch.id || resource.createdByOperationId === proof.origin.id,
          ),
      )
    ) {
      throw new IncusError('Destroy found unattributable branch resource accounting.', 'CONFLICT')
    }
    const snapshots = await tx
      .select()
      .from(t.capsuleSnapshots)
      .where(eq(t.capsuleSnapshots.capsuleId, operation.capsuleId))
      .orderBy(asc(t.capsuleSnapshots.id))
      .for('update')
    const snapshotIds = snapshots.map(snapshot => snapshot.id)
    const captures = await tx
      .select()
      .from(t.capsuleSnapshotCreateOperations)
      .where(
        or(
          inArray(t.capsuleSnapshotCreateOperations.operationId, operationIds),
          inArray(t.capsuleSnapshotCreateOperations.sourceBranchId, branchIds),
          snapshotIds.length === 0 ? undefined : inArray(t.capsuleSnapshotCreateOperations.snapshotId, snapshotIds),
        ),
      )
      .for('update')
    const captureIds = captures.map(capture => capture.operationId)
    const captureResources =
      captureIds.length === 0
        ? []
        : await tx
            .select()
            .from(t.capsuleSnapshotCreateResources)
            .where(inArray(t.capsuleSnapshotCreateResources.operationId, captureIds))
            .for('update')
    const references =
      snapshotIds.length === 0
        ? []
        : await tx
            .select()
            .from(t.capsuleSnapshotResourceReferences)
            .where(inArray(t.capsuleSnapshotResourceReferences.snapshotId, snapshotIds))
            .for('update')
    const snapshotPlans = snapshotTargets({
      branches: proofs,
      operations: byOperation,
      snapshots,
      extensions: captures,
      resources: captureResources,
      references,
      branchResources: resources,
    })
    const aliases = await tx
      .select()
      .from(t.capsuleRouteAliases)
      .where(eq(t.capsuleRouteAliases.capsuleId, operation.capsuleId))
      .for('update')
    const aliasIds = aliases.map(alias => alias.id)
    const revisions = await tx
      .select()
      .from(t.capsuleRouteRevisions)
      .where(
        or(
          aliasIds.length === 0 ? undefined : inArray(t.capsuleRouteRevisions.aliasId, aliasIds),
          inArray(t.capsuleRouteRevisions.operationId, operationIds),
        ),
      )
      .for('update')
    const routeOperations = await tx
      .select()
      .from(t.capsuleRouteOperations)
      .where(
        or(
          aliasIds.length === 0 ? undefined : inArray(t.capsuleRouteOperations.aliasId, aliasIds),
          inArray(t.capsuleRouteOperations.operationId, operationIds),
        ),
      )
      .for('update')
    const providers = await tx
      .select()
      .from(t.capsuleRouteProviderApplications)
      .where(inArray(t.capsuleRouteProviderApplications.operationId, operationIds))
      .for('update')
    const heads =
      aliasIds.length === 0
        ? []
        : await tx
            .select()
            .from(t.capsuleRouteHeads)
            .where(inArray(t.capsuleRouteHeads.aliasId, aliasIds))
            .for('update')
    const previews = await tx
      .select()
      .from(t.capsuleBranchPreviews)
      .where(
        or(
          eq(t.capsuleBranchPreviews.capsuleId, operation.capsuleId),
          inArray(t.capsuleBranchPreviews.branchId, branchIds),
        ),
      )
      .for('update')
    const routes = routeTargets({
      ownerId: operation.ownerId,
      capsuleId: operation.capsuleId,
      server: this.server,
      branches: proofs,
      operations: byOperation,
      previews,
      aliases,
      revisions,
      extensions: routeOperations,
      providers,
      heads,
    })
    const orderedBranches: string[] = []
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (branchId: string): void => {
      if (visited.has(branchId)) {
        return
      }
      if (visiting.has(branchId)) {
        throw new IncusError('Fork deletion dependencies contain a cycle.', 'CONFLICT')
      }
      visiting.add(branchId)
      const proof = proofs.get(branchId)!
      if (proof.sourceSnapshotId !== null) {
        const source = snapshots.find(snapshot => snapshot.id === proof.sourceSnapshotId)
        if (
          !source ||
          !proofs.has(source.sourceBranchId) ||
          source.blueprintName !== proof.blueprint.name ||
          source.blueprintDigest !== proof.blueprint.digest
        ) {
          throw new IncusError('Fork deletion lacks an owned immutable source dependency.', 'CONFLICT', {
            branchId,
            sourceSnapshotId: proof.sourceSnapshotId,
          })
        }
        visit(source.sourceBranchId)
      }
      visiting.delete(branchId)
      visited.add(branchId)
      orderedBranches.push(branchId)
    }
    for (const branchId of [...branchIds].sort()) {
      visit(branchId)
    }
    const branchPlans = new Map([...proofs].map(([id, proof]) => [id, branchTargets(proof)]))
    const instances = [...branchPlans.values()].flat().filter(resource => resource.target.kind === 'instance')
    const storage = orderedBranches
      .reverse()
      .flatMap(branchId => [
        ...snapshotPlans.filter(
          resource => resource.proof.source === 'snapshot' && resource.proof.branchId === branchId,
        ),
        ...branchPlans.get(branchId)!.filter(resource => resource.target.kind === 'volume'),
      ])
    const ordered = [...routes, ...instances, ...storage]
    const identities = new Set<string>()
    for (const resource of ordered) {
      const digest = digestCanonicalJsonValue(resource.target)
      if (identities.has(digest)) {
        throw new IncusError('Destroy plan contains overlapping provider ownership claims.', 'CONFLICT', {
          targetDigest: digest,
        })
      }
      identities.add(digest)
    }
    return {
      document: CapsuleDestroyPlanSchema.parse({
        schemaVersion: 1,
        branchIds,
        resources: ordered,
      }),
      ordered,
    }
  }
}
