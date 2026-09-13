import { and, asc, eq, or } from 'drizzle-orm'
import { IncusError } from '../../../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from '../../../failures'
import { assertCapsuleBranchResourceInventoryMatches } from '../../../resource/inventory'
import { toJsonObject } from '../../../persistence/json'
import { assessBranch, type AssessmentPhase, type BranchAssessment } from '../policy/assessment'
import { lockBranches, lockOperation, type DestroyTransaction } from './locks'
import type { CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { CapsuleResourceProvenance } from '../../../resource/provenance'
import type {
  DestroyBranch,
  DestroyOperation,
  DestroyPlan,
  DestroyProviderTarget,
  DestroyResource,
} from '../types'

/**
 * Destroy-owned resource reads, narrowly scoped repair, and outcome accounting.
 *
 * Create's resource store remains create-only. Every provider transition here
 * revalidates immutable identities inside a capsule-first transaction.
 */
export class DestroyResources<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly provenance: CapsuleResourceProvenance<TDatabase, TTables>,
  ) {}

  public async assess(
    tx: DestroyTransaction<TDatabase>,
    operation: DestroyOperation,
    branches: readonly DestroyBranch[],
    phase: AssessmentPhase,
    repair = false,
  ): Promise<DestroyPlan> {
    const assessments: BranchAssessment[] = []
    for (const branch of branches) {
      const proof = await this.provenance.lock(tx, {
        ownerId: operation.ownerId,
        capsuleId: operation.capsuleId,
        branchId: branch.id,
      })
      let rows = await this.rows(tx, branch.id, proof.origin.id)
      const allowedOperationIds = new Set([proof.origin.id, operation.id])
      if (operation.destroyForce && proof.origin.providerMutationStartedAt !== null) {
        for (const row of rows) {
          if (row.lastOperationId === null || allowedOperationIds.has(row.lastOperationId)) {
            continue
          }
          const operations = this.persistence.tables.capsuleOperations
          const [previous] = await tx
            .select()
            .from(operations)
            .where(eq(operations.id, row.lastOperationId))
            .for('update')
            .limit(1)
          if (
            !previous ||
            previous.type !== 'destroy' ||
            previous.ownerId !== operation.ownerId ||
            previous.capsuleId !== operation.capsuleId ||
            (previous.status !== 'failed' && previous.status !== 'cleanup_required') ||
            previous.providerMutationStartedAt === null
          ) {
            throw new IncusError('Resource last-operation provenance cannot authorize force recovery.', 'CONFLICT', {
              resourceId: row.id,
              lastOperationId: row.lastOperationId,
            })
          }
          allowedOperationIds.add(previous.id)
        }
      }
      const input = {
        operation,
        branch,
        proof,
        phase,
        allowedOperationIds,
      }
      let assessment = assessBranch({
        ...input,
        resources: rows,
        allowRepair: repair && operation.destroyForce && phase === 'plan',
      })
      this.assertAssessment(assessment)
      if (assessment.kind === 'none' && assessment.missing.length > 0) {
        const now = new Date()
        await tx.insert(this.persistence.tables.capsuleBranchResources).values(
          assessment.missing.map(resource => ({
            ownerId: operation.ownerId,
            branchId: branch.id,
            branchName: branch.name,
            createdByOperationId: proof.origin.id,
            lastOperationId: proof.origin.id,
            provider: resource.provider,
            resourceType: resource.resourceType,
            resourceKey: resource.resourceKey,
            blueprintVolumeName: resource.blueprintVolumeName,
            cleanupPolicy: resource.cleanupPolicy,
            metadata: resource.metadata,
            status: 'planned' as const,
            createdAt: now,
            updatedAt: now,
          })),
        )
        rows = await this.rows(tx, branch.id, proof.origin.id)
        assessment = assessBranch({
          ...input,
          resources: rows,
          allowRepair: false,
        })
        this.assertAssessment(assessment)
      }
      if (proof.recordedInventoryDigest !== null) {
        assertCapsuleBranchResourceInventoryMatches(
          proof.recordedInventoryDigest,
          rows.map(resource => ({
            provider: resource.provider,
            resourceType: resource.resourceType,
            resourceKey: resource.resourceKey,
            blueprintVolumeName: resource.blueprintVolumeName,
            cleanupPolicy: resource.cleanupPolicy,
            metadata: resource.metadata,
          })),
        )
      }
      assessments.push(assessment)
    }

    const plan: DestroyPlan = {
      branchCount: branches.length,
      instances: [],
      volumes: [],
      files: [],
      providerRequired: false,
    }
    for (const assessment of assessments) {
      if (assessment.kind !== 'delete') {
        continue
      }
      plan.instances.push(...assessment.instances)
      plan.volumes.push(...assessment.volumes)
      plan.files.push(...assessment.files)
    }
    plan.providerRequired = plan.instances.length > 0 || plan.volumes.length > 0
    this.assertUniqueTargets(plan)
    return plan
  }

  public async intent(operationId: string, target: DestroyProviderTarget): Promise<void> {
    await this.transition(operationId, target, 'deleting')
  }

  public async outcome(
    operationId: string,
    target: DestroyProviderTarget,
    status: 'deleted' | 'missing',
  ): Promise<void> {
    await this.transition(operationId, target, status)
  }

  public async failure(operationId: string, target: DestroyProviderTarget, error: unknown): Promise<void> {
    await this.transition(operationId, target, 'error', error)
  }

  /**
   * Derived files have no independent provider deletion call. Their backing
   * resource must already have a clean outcome from this destroy.
   */
  public async finalizeFiles(operationId: string): Promise<void> {
    await this.persistence.db.transaction(async tx => {
      const { operation, plan } = await this.lockExecution(tx, operationId)
      const resources = this.persistence.tables.capsuleBranchResources
      for (const file of plan.files) {
        const [backing] = await tx
          .select()
          .from(resources)
          .where(eq(resources.id, file.backingResourceId))
          .for('update')
          .limit(1)
        if (
          !backing ||
          backing.lastOperationId !== operation.id ||
          (backing.status !== 'deleted' && backing.status !== 'missing') ||
          backing.failureCode !== null ||
          backing.failureMessage !== null ||
          backing.failureDetails !== null
        ) {
          throw new IncusError('Provisioning file has no clean terminal backing-resource outcome.', 'CONFLICT', {
            resourceId: file.id,
            backingResourceId: file.backingResourceId,
          })
        }
        const [updated] = await tx
          .update(resources)
          .set({
            status: 'deleted',
            lastOperationId: operation.id,
            failureCode: null,
            failureMessage: null,
            failureDetails: null,
            updatedAt: new Date(),
          })
          .where(and(eq(resources.id, file.id), eq(resources.branchId, file.branchId)))
          .returning({ id: resources.id })
        if (!updated) {
          throw new IncusError('Derived destroy outcome could not be persisted.', 'CONFLICT')
        }
      }
    })
  }

  private async transition(
    operationId: string,
    target: DestroyProviderTarget,
    status: 'deleting' | 'deleted' | 'missing' | 'error',
    error?: unknown,
  ): Promise<void> {
    await this.persistence.db.transaction(async tx => {
      const { operation, plan } = await this.lockExecution(tx, operationId)
      const proven = [...plan.instances, ...plan.volumes].find(resource => resource.id === target.id)
      if (
        !proven ||
        proven.kind !== target.kind ||
        proven.branchId !== target.branchId ||
        proven.namespace !== target.namespace ||
        proven.resourceKey !== target.resourceKey ||
        (proven.kind === 'instance' &&
          target.kind === 'instance' &&
          proven.instanceName !== target.instanceName) ||
        (proven.kind === 'volume' &&
          target.kind === 'volume' &&
          (proven.pool !== target.pool || proven.volumeName !== target.volumeName))
      ) {
        throw new IncusError('Provider target no longer matches the immutable destroy assessment.', 'CONFLICT')
      }
      const resources = this.persistence.tables.capsuleBranchResources
      const [resource] = await tx
        .select()
        .from(resources)
        .where(eq(resources.id, target.id))
        .for('update')
        .limit(1)
      if (!resource) {
        throw new IncusError('Destroy resource was not found.', 'CONFLICT')
      }
      if (status === 'deleting') {
        if (
          resource.lastOperationId === operation.id ||
          (!operation.destroyForce && resource.status !== 'created')
        ) {
          throw new IncusError('Destroy does not retry an already-attempted resource mutation.', 'CONFLICT')
        }
      } else if (resource.status !== 'deleting' || resource.lastOperationId !== operation.id) {
        throw new IncusError('Destroy outcome requires this operation’s recorded delete intent.', 'CONFLICT')
      }
      const details =
        status === 'error'
          ? createFailureDetails(error, {
              operationId,
              resourceId: resource.id,
              resourceKey: resource.resourceKey,
            })
          : undefined
      const [updated] = await tx
        .update(resources)
        .set({
          status,
          lastOperationId: operation.id,
          failureCode: status === 'error' ? failureCodeFromUnknown(error) : null,
          failureMessage: status === 'error' ? failureMessageFromUnknown(error) : null,
          failureDetails: details === undefined ? null : toJsonObject(details, 'destroy resource failure'),
          updatedAt: new Date(),
        })
        .where(and(eq(resources.id, resource.id), eq(resources.status, resource.status)))
        .returning({ id: resources.id })
      if (!updated) {
        throw new IncusError('Destroy resource transition conflicted with durable state.', 'CONFLICT')
      }
    })
  }

  private async lockExecution(tx: DestroyTransaction<TDatabase>, operationId: string) {
    const { operation, capsule } = await lockOperation<TDatabase>(tx, this.persistence.tables, operationId)
    if (
      operation.status !== 'running' ||
      operation.executionStartedAt === null ||
      operation.providerMutationStartedAt === null ||
      operation.completedAt !== null ||
      operation.failedAt !== null ||
      capsule.lifecycleStatus !== 'destroying'
    ) {
      throw new IncusError('Resource mutation requires a fenced running destroy operation.', 'CONFLICT')
    }
    const branches = await lockBranches<TDatabase>(tx, this.persistence.tables, operation.capsuleId)
    if (
      branches.length === 0 ||
      branches.some(
        branch =>
          branch.ownerId !== operation.ownerId ||
          (branch.status !== 'destroying' && !(operation.destroyForce && branch.status === 'destroyed')),
      )
    ) {
      throw new IncusError('Resource mutation requires intact destroy branch fences.', 'CONFLICT')
    }
    const plan = await this.assess(tx, operation, branches, 'execution')
    return { operation, plan }
  }

  private async rows(
    tx: DestroyTransaction<TDatabase>,
    branchId: string,
    originId: string,
  ): Promise<DestroyResource[]> {
    const resources = this.persistence.tables.capsuleBranchResources
    return await tx
      .select()
      .from(resources)
      .where(or(eq(resources.branchId, branchId), eq(resources.createdByOperationId, originId)))
      .orderBy(asc(resources.resourceKey), asc(resources.id))
      .for('update')
  }

  private assertAssessment(assessment: BranchAssessment): void {
    if (assessment.kind === 'cleanup') {
      throw new IncusError(assessment.reason, 'CONFLICT', {
        branchId: assessment.branchId,
        assessment: 'cleanup_required',
      })
    }
  }

  private assertUniqueTargets(plan: DestroyPlan): void {
    const identities = new Set<string>()
    for (const target of [...plan.instances, ...plan.volumes]) {
      const identity =
        target.kind === 'instance'
          ? `instance\u0000${target.namespace}\u0000${target.instanceName}`
          : `volume\u0000${target.namespace}\u0000${target.pool}\u0000${target.volumeName}`
      if (identities.has(identity)) {
        throw new IncusError('Destroy assessment contains duplicate provider identities.', 'CONFLICT')
      }
      identities.add(identity)
    }
  }
}
