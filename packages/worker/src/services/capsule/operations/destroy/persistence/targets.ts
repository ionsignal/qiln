import { and, asc, eq, isNull } from 'drizzle-orm'
import {
  CapsuleDestroyDigestSchema,
  CapsuleDestroyObservationSchema,
  CapsuleDestroyPlanSchema,
  SshCapsuleAccessRevocationOutputSchema,
  digestCanonicalJsonValue,
  toCanonicalJsonValue,
  type CapsuleDestroyObservation,
  type CapsuleDestroyPlan,
  type CapsuleDestroyResourcePlan,
  type CapsuleDestroyTarget,
  type CapsulePersistence,
  type CapsuleTables,
  type SshCapsuleAccessRevocationOutput,
} from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError } from '../../../../../errors'
import { lockOperation, type DestroyTransaction } from './locks'
import type { DestroyCapsule, DestroyOperation } from '../types'

type DestroyPlanRow = CapsuleTables['capsuleDestroyOperations']['$inferSelect']
type DestroyTargetRow = CapsuleTables['capsuleDestroyResources']['$inferSelect']

export interface DestroyTargetState {
  operation: DestroyOperation
  capsule: DestroyCapsule
  plan: DestroyPlanRow
  targets: DestroyTargetRow[]
}

function targetDigest(target: CapsuleDestroyTarget): string {
  return digestCanonicalJsonValue(target, {
    context: 'destroy exact provider target',
  })
}

function canonicalPlan(value: unknown): CapsuleDestroyPlan {
  const parsed = CapsuleDestroyPlanSchema.parse(value)
  const resources = parsed.resources.map(resource => ({
    resource,
    digest: targetDigest(resource.target),
  }))
  const identities = new Set(resources.map(resource => resource.digest))
  if (identities.size !== resources.length) {
    throw new IncusError('Destroy plan contains duplicate provider targets.', 'CONFLICT')
  }
  resources.sort((left, right) => {
    return left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0
  })
  return {
    schemaVersion: parsed.schemaVersion,
    branchIds: [...parsed.branchIds].sort(),
    resources: resources.map(resource => resource.resource),
  }
}

function planDigest(plan: CapsuleDestroyPlan): string {
  return digestCanonicalJsonValue(plan, {
    context: 'destroy immutable plan',
  })
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const first = [...left].sort()
  const second = [...right].sort()
  return first.length === second.length && first.every((id, index) => id === second[index])
}

/**
 * Persists one destroy attempt's independently proven obligations.
 *
 * Proof resolution remains operation-specific. This repository does not infer
 * ownership from names, repair earlier resource rows, discover provider
 * resources, or authorize continuation of a terminal operation.
 *
 * Every write locks capsule → operation → destroy plan → targets. Completion
 * policy must additionally establish complete resource and ingress coverage.
 */
export class DestroyTargets<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(private readonly persistence: CapsulePersistence<TDatabase, TTables>) {}

  public async plan(operationId: string, value: CapsuleDestroyPlan): Promise<DestroyTargetState> {
    const plan = canonicalPlan(value)
    const digest = CapsuleDestroyDigestSchema.parse(planDigest(plan))
    return await this.persistence.db.transaction(async tx => {
      const locked = await lockOperation<TDatabase>(tx, this.persistence.tables, operationId)
      this.assertRunning(locked.operation, locked.capsule)
      if (locked.operation.providerMutationStartedAt !== null) {
        throw new IncusError('Destroy targets must be planned before provider intent.', 'CONFLICT', { operationId })
      }
      const { capsuleBranches, capsuleDestroyOperations, capsuleDestroyResources } = this.persistence.tables
      const branches = await tx
        .select({
          id: capsuleBranches.id,
          ownerId: capsuleBranches.ownerId,
        })
        .from(capsuleBranches)
        .where(eq(capsuleBranches.capsuleId, locked.capsule.id))
        .orderBy(asc(capsuleBranches.id))
        .for('update')
      if (
        branches.some(branch => branch.ownerId !== locked.operation.ownerId) ||
        !sameIds(
          plan.branchIds,
          branches.map(branch => branch.id),
        )
      ) {
        throw new IncusError('Destroy plan does not cover the complete owned branch scope.', 'CONFLICT', {
          operationId,
        })
      }
      const [existing] = await tx
        .select({ operationId: capsuleDestroyOperations.operationId })
        .from(capsuleDestroyOperations)
        .where(eq(capsuleDestroyOperations.operationId, operationId))
        .for('update')
        .limit(1)
      if (existing) {
        throw new IncusError('Destroy plan already exists and cannot be replaced or resumed.', 'CONFLICT', {
          operationId,
        })
      }
      const now = new Date()
      await tx.insert(capsuleDestroyOperations).values({
        operationId,
        schemaVersion: plan.schemaVersion,
        planDigest: digest,
        branchIds: plan.branchIds,
        targetCount: plan.resources.length,
        plannedAt: now,
      })
      if (plan.resources.length > 0) {
        await tx.insert(capsuleDestroyResources).values(
          plan.resources.map(resource => ({
            operationId,
            targetDigest: CapsuleDestroyDigestSchema.parse(targetDigest(resource.target)),
            target: resource.target,
            proof: resource.proof,
            status: 'planned' as const,
            createdAt: now,
            updatedAt: now,
          })),
        )
      }
      return await this.load(tx, locked.operation, locked.capsule)
    })
  }

  /**
   * Reads terminal attempts as audit evidence without making them executable.
   */
  public async read(operationId: string): Promise<DestroyTargetState> {
    return await this.persistence.db.transaction(async tx => {
      const locked = await lockOperation<TDatabase>(tx, this.persistence.tables, operationId)
      return await this.load(tx, locked.operation, locked.capsule)
    })
  }

  /**
   * Records the existing SSH authority's response for this exact branch scope.
   *
   * Shape validation is not SSH authorization. The executor must obtain this
   * response directly from the authenticated authority command.
   */
  public async recordRevocation(operationId: string, value: SshCapsuleAccessRevocationOutput): Promise<void> {
    const report = SshCapsuleAccessRevocationOutputSchema.parse(value)
    await this.persistence.db.transaction(async tx => {
      const state = await this.lock(tx, operationId)
      if (
        state.operation.providerMutationStartedAt !== null ||
        state.plan.sshRevocation !== null ||
        state.plan.sshRevokedAt !== null
      ) {
        throw new IncusError('Destroy SSH evidence must be recorded once before provider intent.', 'CONFLICT', {
          operationId,
        })
      }
      const branchIds = report.branchAccess.map(access => access.branchId)
      if (
        report.capsuleId !== state.operation.capsuleId ||
        new Set(branchIds).size !== branchIds.length ||
        !sameIds(branchIds, state.plan.branchIds) ||
        report.branchAccess.some(access => access.capsuleId !== state.operation.capsuleId || access.state !== 'blocked')
      ) {
        throw new IncusError('SSH revocation does not cover the destroy plan’s complete branch scope.', 'CONFLICT', {
          operationId,
        })
      }
      const operations = this.persistence.tables.capsuleDestroyOperations
      const [updated] = await tx
        .update(operations)
        .set({
          sshRevocation: report,
          sshRevokedAt: new Date(),
        })
        .where(and(eq(operations.operationId, operationId), isNull(operations.sshRevokedAt)))
        .returning({ operationId: operations.operationId })
      if (!updated) {
        throw new IncusError('Destroy SSH revocation accounting conflicted with another transition.', 'CONFLICT', {
          operationId,
        })
      }
    })
  }

  /**
   * Records one fresh exact-target observation before mutation.
   *
   * A present observation preserves configuration drift in the before document.
   * An absent observation satisfies the obligation without fabricating intent.
   */
  public async inspect(
    operationId: string,
    resourceId: string,
    value: CapsuleDestroyObservation,
  ): Promise<DestroyTargetRow> {
    return await this.persistence.db.transaction(async tx => {
      const state = await this.lock(tx, operationId)
      const resource = this.target(state, resourceId)
      if (
        resource.status !== 'planned' ||
        resource.before !== null ||
        resource.after !== null ||
        resource.intentAt !== null
      ) {
        throw new IncusError('Destroy target inspection cannot replace existing attempt evidence.', 'CONFLICT', {
          operationId,
          resourceId,
        })
      }
      const observation = this.observation(resource, value, resource.createdAt)
      const observedAt = new Date(observation.observedAt)
      const resources = this.persistence.tables.capsuleDestroyResources
      const [updated] = await tx
        .update(resources)
        .set({
          before: observation,
          status:
            observation.state === 'absent' ? 'absent' : observation.state === 'present' ? 'planned' : 'unresolved',
          verifiedAt: observation.state === 'absent' ? observedAt : null,
          updatedAt: new Date(),
        })
        .where(and(eq(resources.id, resource.id), eq(resources.status, 'planned'), isNull(resources.before)))
        .returning()
      return this.require(updated, operationId, resourceId)
    })
  }

  public async intent(operationId: string, resourceId: string): Promise<DestroyTargetRow> {
    return await this.persistence.db.transaction(async tx => {
      const state = await this.lock(tx, operationId)
      const resource = this.target(state, resourceId)
      if (
        state.operation.providerMutationStartedAt === null ||
        state.plan.sshRevokedAt === null ||
        state.plan.sshRevocation === null ||
        resource.status !== 'planned' ||
        resource.before === null ||
        resource.after !== null ||
        resource.intentAt !== null
      ) {
        throw new IncusError(
          'Deletion requires this attempt’s provider fence, SSH closure, and target inspection.',
          'CONFLICT',
          {
            operationId,
            resourceId,
          },
        )
      }
      const before = this.observation(resource, resource.before, resource.createdAt)
      if (before.state !== 'present') {
        throw new IncusError('Deletion intent requires a positively observed present target.', 'CONFLICT', {
          operationId,
          resourceId,
        })
      }
      const resources = this.persistence.tables.capsuleDestroyResources
      const now = new Date()
      const [updated] = await tx
        .update(resources)
        .set({
          status: 'deleting',
          intentAt: now,
          updatedAt: now,
        })
        .where(and(eq(resources.id, resource.id), eq(resources.status, 'planned'), isNull(resources.intentAt)))
        .returning()
      return this.require(updated, operationId, resourceId)
    })
  }

  /**
   * Only exact-target absence completes an attempted deletion.
   *
   * The caller must not submit absence while an earlier asynchronous mutation
   * could still create or reintroduce the target. Provider-operation settlement
   * and that uncertainty classification remain adapter/executor
   * responsibilities.
   */
  public async settle(
    operationId: string,
    resourceId: string,
    value: CapsuleDestroyObservation,
  ): Promise<DestroyTargetRow> {
    return await this.persistence.db.transaction(async tx => {
      const state = await this.lock(tx, operationId)
      const resource = this.target(state, resourceId)
      if (
        state.operation.providerMutationStartedAt === null ||
        resource.status !== 'deleting' ||
        resource.intentAt === null ||
        resource.after !== null
      ) {
        throw new IncusError('Destroy outcome requires this attempt’s unresolved deletion intent.', 'CONFLICT', {
          operationId,
          resourceId,
        })
      }
      const observation = this.observation(resource, value, resource.intentAt)
      const resources = this.persistence.tables.capsuleDestroyResources
      const [updated] = await tx
        .update(resources)
        .set({
          after: observation,
          status: observation.state === 'absent' ? 'deleted' : 'unresolved',
          verifiedAt: observation.state === 'absent' ? new Date(observation.observedAt) : null,
          updatedAt: new Date(),
        })
        .where(and(eq(resources.id, resource.id), eq(resources.status, 'deleting'), isNull(resources.after)))
        .returning()
      return this.require(updated, operationId, resourceId)
    })
  }

  public async load(
    tx: DestroyTransaction<TDatabase>,
    operation: DestroyOperation,
    capsule: DestroyCapsule,
  ): Promise<DestroyTargetState> {
    const { capsuleDestroyOperations, capsuleDestroyResources } = this.persistence.tables
    const [plan] = await tx
      .select()
      .from(capsuleDestroyOperations)
      .where(eq(capsuleDestroyOperations.operationId, operation.id))
      .for('update')
      .limit(1)
    if (!plan) {
      throw new IncusError('Destroy operation has no immutable target plan.', 'CONFLICT', {
        operationId: operation.id,
      })
    }
    const targets = await tx
      .select()
      .from(capsuleDestroyResources)
      .where(eq(capsuleDestroyResources.operationId, operation.id))
      .orderBy(asc(capsuleDestroyResources.targetDigest), asc(capsuleDestroyResources.id))
      .for('update')
    const resources: CapsuleDestroyResourcePlan[] = targets.map(resource => ({
      target: resource.target,
      proof: resource.proof,
    }))
    const reconstructed = canonicalPlan({
      schemaVersion: plan.schemaVersion,
      branchIds: plan.branchIds,
      resources,
    })
    if (
      plan.targetCount !== targets.length ||
      planDigest(reconstructed) !== plan.planDigest ||
      targets.some(resource => targetDigest(resource.target) !== resource.targetDigest)
    ) {
      throw new IncusError('Destroy target accounting does not match its immutable plan.', 'CONFLICT', {
        operationId: operation.id,
      })
    }
    return {
      operation,
      capsule,
      plan,
      targets,
    }
  }

  private async lock(tx: DestroyTransaction<TDatabase>, operationId: string): Promise<DestroyTargetState> {
    const locked = await lockOperation<TDatabase>(tx, this.persistence.tables, operationId)
    this.assertRunning(locked.operation, locked.capsule)
    return await this.load(tx, locked.operation, locked.capsule)
  }

  private assertRunning(operation: DestroyOperation, capsule: DestroyCapsule): void {
    if (
      operation.type !== 'destroy' ||
      operation.status !== 'running' ||
      operation.executionStartedAt === null ||
      operation.completedAt !== null ||
      operation.failedAt !== null ||
      operation.failureCode !== null ||
      operation.failureMessage !== null ||
      operation.failureDetails !== null ||
      capsule.lifecycleStatus !== 'destroying' ||
      capsule.destroyedAt !== null
    ) {
      throw new IncusError('Target accounting requires a fenced running destroy operation.', 'CONFLICT', {
        operationId: operation.id,
      })
    }
  }

  private target(state: DestroyTargetState, resourceId: string): DestroyTargetRow {
    const target = state.targets.find(resource => resource.id === resourceId)
    if (!target) {
      throw new IncusError('Target does not belong to this destroy operation.', 'CONFLICT', {
        operationId: state.operation.id,
        resourceId,
      })
    }
    return target
  }

  private observation(
    resource: DestroyTargetRow,
    value: CapsuleDestroyObservation,
    notBefore: Date,
  ): CapsuleDestroyObservation {
    const observation = CapsuleDestroyObservationSchema.parse(value)
    toCanonicalJsonValue(observation, 'destroy provider observation')
    if (
      targetDigest(observation.target) !== resource.targetDigest ||
      new Date(observation.observedAt).getTime() < notBefore.getTime()
    ) {
      throw new IncusError(
        'Provider observation does not match the exact target or this attempt’s timeline.',
        'CONFLICT',
        {
          operationId: resource.operationId,
          resourceId: resource.id,
        },
      )
    }
    return observation
  }

  private require(resource: DestroyTargetRow | undefined, operationId: string, resourceId: string): DestroyTargetRow {
    if (!resource) {
      throw new IncusError('Destroy target accounting conflicted with another transition.', 'CONFLICT', {
        operationId,
        resourceId,
      })
    }
    return resource
  }
}
