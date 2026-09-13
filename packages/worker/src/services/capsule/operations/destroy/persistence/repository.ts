import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { CapsuleDestroyReceiptSchema } from '@qiln/core/server'
import { IncusError, isUniqueConstraintViolation } from '../../../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from '../../../failures'
import { toJsonObject } from '../../../persistence/json'
import { assertOperationReplayIdentity, toCapsuleLifecycleState, toCapsuleOperationTransition } from '../../shared'
import { DestroyStepKeys } from '../execution/steps'
import { lockBranches, lockCapsule, lockOperation, type DestroyTransaction } from './locks'
import type { CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { PreviewGate } from '../../../routing/preview/gate'
import type { RouteGate } from '../../../routing/gate'
import type { DestroyResources } from './resources'
import type {
  AcceptDestroyCapsuleOperationInput,
  DestroyBranch,
  DestroyCapsule,
  DestroyCapsuleRepositoryResult,
  DestroyCapsuleTerminalResult,
  DestroyExecution,
  DestroyOperation,
} from '../types'

interface LockedDestroy {
  operation: DestroyOperation
  capsule: DestroyCapsule
  branches: DestroyBranch[]
}

/**
 * Owns destroy acceptance, replay, execution fences, completion, and failure
 * transactions.
 *
 * Force recovery and normal destroy share resource identity assessment, not
 * eligibility policy. No transaction invokes a provider or resumes an executor.
 */
export class DestroyCapsuleOperationRepository<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly resources: DestroyResources<TDatabase, TTables>,
    private readonly previews: PreviewGate<TDatabase, TTables>,
    private readonly routes: RouteGate<TDatabase, TTables>,
  ) {}

  public async acceptOrReplay(input: AcceptDestroyCapsuleOperationInput): Promise<DestroyCapsuleRepositoryResult> {
    const replay = await this.replay(input)
    if (replay) {
      return replay
    }
    const tables = this.persistence.tables
    try {
      return await this.persistence.db.transaction(async tx => {
        const capsule = await lockCapsule<TDatabase>(tx, tables, input.ownerId, input.capsuleId)
        const raced = await this.findReplay(tx, input)
        if (raced) {
          return raced
        }
        const [active] = await tx
          .select({ id: tables.capsuleOperations.id })
          .from(tables.capsuleOperations)
          .where(
            and(
              eq(tables.capsuleOperations.capsuleId, capsule.id),
              inArray(tables.capsuleOperations.status, ['accepted', 'running']),
            ),
          )
          .limit(1)
        if (active) {
          throw new IncusError('Capsule already has a nonterminal operation.', 'CONFLICT')
        }
        if (capsule.lifecycleStatus === 'destroyed' || capsule.destroyedAt !== null) {
          throw new IncusError('Destroyed capsules cannot be destroyed again.', 'CONFLICT')
        }
        if (!input.force && (capsule.lifecycleStatus !== 'active' || capsule.archivedAt === null)) {
          throw new IncusError('Normal destroy requires an active archived capsule.', 'CONFLICT')
        }
        await this.assertRetention(tx, input.ownerId, capsule.id)
        const branches = await lockBranches<TDatabase>(tx, tables, capsule.id)
        this.assertLineage(branches, input.ownerId, capsule.id, input.force, 'acceptance')
        if (!input.force) {
          await this.previews.assertBranchesWithdrawn(
            tx,
            input.ownerId,
            capsule.id,
            branches.map(branch => branch.id),
          )
        }
        const now = new Date()
        const [operation] = await tx
          .insert(tables.capsuleOperations)
          .values({
            ownerId: input.ownerId,
            actorType: input.actor.type,
            actorId: input.actor.id,
            capsuleId: capsule.id,
            type: 'destroy',
            status: 'accepted',
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            destroyForce: input.force,
            destroyForceReason: input.force ? input.reason : null,
            destroyForceAcknowledged: input.force,
            acceptedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
        if (!operation) {
          throw new IncusError('Failed to accept capsule destroy.', 'API_ERROR')
        }
        this.assertForcePolicy(operation)
        if (!input.force) {
          await this.resources.assess(tx, operation, branches, 'plan')
        }
        const [destroying] = await tx
          .update(tables.capsules)
          .set({ lifecycleStatus: 'destroying', updatedAt: now })
          .where(eq(tables.capsules.id, capsule.id))
          .returning()
        if (!destroying) {
          throw new IncusError('Failed to fence the capsule for destroy.', 'CONFLICT')
        }
        const fenced: DestroyBranch[] = []
        for (const branch of branches) {
          if (branch.status === 'destroyed') {
            fenced.push(branch)
            continue
          }
          const [updated] = await tx
            .update(tables.capsuleBranches)
            .set({ status: 'destroying', runtimeIp: null, updatedAt: now })
            .where(eq(tables.capsuleBranches.id, branch.id))
            .returning()
          if (!updated) {
            throw new IncusError('Failed to fence a capsule branch for destroy.', 'CONFLICT')
          }
          fenced.push(updated)
        }
        return this.result({ operation, capsule: destroying, branches: fenced }, true, false)
      })
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) {
        throw error
      }
      const raced = await this.replay(input)
      if (raced) {
        return raced
      }
      throw new IncusError('Destroy conflicts with another durable capsule operation.', 'CONFLICT')
    }
  }

  public async claim(operationId: string): Promise<DestroyCapsuleTerminalResult['operation']> {
    return await this.persistence.db.transaction(async tx => {
      const locked = await this.lock(tx, operationId)
      this.assertExecution(locked, 'accepted')
      const operations = this.persistence.tables.capsuleOperations
      const now = new Date()
      const [operation] = await tx
        .update(operations)
        .set({ status: 'running', executionStartedAt: now, updatedAt: now })
        .where(and(eq(operations.id, operationId), eq(operations.status, 'accepted')))
        .returning()
      if (!operation) {
        throw new IncusError('Destroy could not be claimed.', 'CONFLICT')
      }
      return this.terminal({ ...locked, operation }).operation
    })
  }

  /**
   * All branches are assessed before destructive calls become eligible.
   *
   * Repair and final digest verification share this transaction. A later
   * contradictory branch rolls back every repair made during the assessment.
   */
  public async prepare(operationId: string): Promise<DestroyExecution> {
    return await this.persistence.db.transaction(async tx => {
      const locked = await this.lock(tx, operationId)
      this.assertExecution(locked, 'running')
      if (locked.operation.providerMutationStartedAt !== null) {
        throw new IncusError('Destroy planning cannot resume after provider intent.', 'CONFLICT')
      }
      await this.assertRetention(tx, locked.operation.ownerId, locked.operation.capsuleId)
      const plan = await this.resources.assess(tx, locked.operation, locked.branches, 'plan', true)
      const previews = this.persistence.tables.capsuleBranchPreviews
      const branchIds = locked.branches.map(branch => branch.id)
      const rows = await tx
        .select()
        .from(previews)
        .where(eq(previews.capsuleId, locked.operation.capsuleId))
        .orderBy(asc(previews.id))
        .for('update')
      if (
        rows.some(
          preview =>
            preview.ownerId !== locked.operation.ownerId || !branchIds.includes(preview.branchId),
        )
      ) {
        throw new IncusError('Preview ownership does not match destroy lineage.', 'CONFLICT')
      }
      const withdrawPreviews = rows.some(preview => preview.status !== 'inactive')
      if (!locked.operation.destroyForce || !withdrawPreviews) {
        await this.previews.assertBranchesWithdrawn(
          tx,
          locked.operation.ownerId,
          locked.operation.capsuleId,
          branchIds,
        )
      }
      return {
        operationId,
        ownerId: locked.operation.ownerId,
        capsuleId: locked.operation.capsuleId,
        force: locked.operation.destroyForce,
        plan,
        withdrawPreviews,
      }
    })
  }

  /**
   * Provider intent covers both Caddy withdrawal and Incus deletion.
   *
   * Provider-free destroys never call this method.
   */
  public async fence(operationId: string): Promise<void> {
    await this.persistence.db.transaction(async tx => {
      const locked = await this.lock(tx, operationId)
      this.assertExecution(locked, 'running')
      await this.assertRetention(tx, locked.operation.ownerId, locked.operation.capsuleId)
      await this.resources.assess(tx, locked.operation, locked.branches, 'execution')
      const operations = this.persistence.tables.capsuleOperations
      const now = new Date()
      const [updated] = await tx
        .update(operations)
        .set({ providerMutationStartedAt: now, updatedAt: now })
        .where(and(eq(operations.id, operationId), isNull(operations.providerMutationStartedAt)))
        .returning({ id: operations.id })
      if (!updated) {
        throw new IncusError('Destroy provider intent was already recorded.', 'CONFLICT')
      }
    })
  }

  public async verify(operationId: string): Promise<void> {
    await this.persistence.db.transaction(async tx => {
      const locked = await this.lock(tx, operationId)
      await this.assertCompletion(tx, locked, false)
    })
  }

  public async complete(operationId: string): Promise<DestroyCapsuleTerminalResult> {
    return await this.persistence.db.transaction(async tx => {
      const locked = await this.lock(tx, operationId)
      await this.assertCompletion(tx, locked, true)
      return await this.finish(tx, locked)
    })
  }

  public async classifyExecutionFailure(
    operationId: string,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<DestroyCapsuleTerminalResult | null> {
    return await this.classify(operationId, error, context, false)
  }

  public async classifyAbandoned(operationId: string): Promise<DestroyCapsuleTerminalResult | null> {
    return await this.classify(
      operationId,
      new IncusError('Destroy was abandoned by a previous Worker process.', 'API_ERROR'),
      { phase: 'startup_abandoned_operation_classification', policy: 'no_provider_mutation_after_restart' },
      true,
    )
  }

  private async classify(
    operationId: string,
    error: unknown,
    context: Record<string, unknown>,
    abandoned: boolean,
  ): Promise<DestroyCapsuleTerminalResult | null> {
    return await this.persistence.db.transaction(async tx => {
      const locked = await this.lock(tx, operationId)
      if (locked.operation.status !== 'accepted' && locked.operation.status !== 'running') {
        return null
      }

      /**
       * This is finalization of already-finished provider-free work, not
       * execution recovery. Missing safety accounting never authorizes it.
       */
      if (
        abandoned &&
        locked.operation.destroyForce &&
        locked.operation.status === 'running' &&
        locked.operation.providerMutationStartedAt === null
      ) {
        let ready = false
        try {
          const plan = await this.assertCompletion(tx, locked, true)
          ready = !plan.providerRequired
        } catch (validationError: unknown) {
          if (!(validationError instanceof IncusError)) {
            throw validationError
          }
        }
        if (ready) {
          return await this.finish(tx, locked)
        }
      }

      let restore = false
      if (!locked.operation.destroyForce && locked.operation.providerMutationStartedAt === null) {
        try {
          this.assertExecution(
            locked,
            locked.operation.status === 'accepted' ? 'accepted' : 'running',
          )
          await this.assertRetention(tx, locked.operation.ownerId, locked.operation.capsuleId)
          await this.previews.assertBranchesWithdrawn(
            tx,
            locked.operation.ownerId,
            locked.operation.capsuleId,
            locked.branches.map(branch => branch.id),
          )
          await this.resources.assess(tx, locked.operation, locked.branches, 'plan')
          restore = true
        } catch (validationError: unknown) {
          if (!(validationError instanceof IncusError)) {
            throw validationError
          }
        }
      }
      const tables = this.persistence.tables
      const now = new Date()
      const details = createFailureDetails(error, {
        ...context,
        force: locked.operation.destroyForce,
        providerIntentPresent: locked.operation.providerMutationStartedAt !== null,
        classification: restore ? 'safe_pre_provider_failure' : 'cleanup_required',
      })
      const [operation] = await tx
        .update(tables.capsuleOperations)
        .set({
          status: restore ? 'failed' : 'cleanup_required',
          completedAt: null,
          failedAt: now,
          failureCode: failureCodeFromUnknown(error),
          failureMessage: failureMessageFromUnknown(error),
          failureDetails: details === undefined ? null : toJsonObject(details, 'destroy failure'),
          updatedAt: now,
        })
        .where(eq(tables.capsuleOperations.id, operationId))
        .returning()
      let capsule = locked.capsule
      if (capsule.lifecycleStatus !== 'destroyed') {
        const [updated] = await tx
          .update(tables.capsules)
          .set({ lifecycleStatus: restore ? 'active' : 'cleanup_required', updatedAt: now })
          .where(eq(tables.capsules.id, capsule.id))
          .returning()
        if (!updated) {
          throw new IncusError('Destroy failure could not be persisted on the capsule.', 'CONFLICT')
        }
        capsule = updated
      }
      const branches: DestroyBranch[] = []
      for (const branch of locked.branches) {
        if (branch.ownerId !== locked.operation.ownerId || branch.status === 'destroyed') {
          branches.push(branch)
          continue
        }
        const [updated] = await tx
          .update(tables.capsuleBranches)
          .set({
            status: restore ? 'offline' : 'cleanup_required',
            runtimeIp: null,
            updatedAt: now,
          })
          .where(eq(tables.capsuleBranches.id, branch.id))
          .returning()
        if (!updated) {
          throw new IncusError('Destroy failure could not be persisted on the branch.', 'CONFLICT')
        }
        branches.push(updated)
      }
      if (!operation) {
        throw new IncusError('Destroy failure could not be persisted.', 'CONFLICT')
      }
      return this.terminal({ operation, capsule, branches })
    })
  }

  private async assertCompletion(
    tx: DestroyTransaction<TDatabase>,
    locked: LockedDestroy,
    requireSteps: boolean,
  ) {
    this.assertExecution(locked, 'running')
    await this.assertRetention(tx, locked.operation.ownerId, locked.operation.capsuleId)
    await this.previews.assertBranchesWithdrawn(
      tx,
      locked.operation.ownerId,
      locked.operation.capsuleId,
      locked.branches.map(branch => branch.id),
    )
    const plan = await this.resources.assess(tx, locked.operation, locked.branches, 'completion')
    if (plan.providerRequired && locked.operation.providerMutationStartedAt === null) {
      throw new IncusError('Provider deletion outcomes require destroy provider intent.', 'CONFLICT')
    }
    if (requireSteps) {
      const steps = this.persistence.tables.capsuleOperationSteps
      const rows = await tx
        .select()
        .from(steps)
        .where(eq(steps.operationId, locked.operation.id))
        .orderBy(asc(steps.id))
        .for('update')
      const completed = new Set(
        rows
          .filter(
            step =>
              step.ownerId === locked.operation.ownerId &&
              step.capsuleId === locked.operation.capsuleId &&
              step.branchId === null &&
              step.status === 'completed' &&
              step.startedAt !== null &&
              step.completedAt !== null &&
              step.failedAt === null &&
              step.failureCode === null &&
              step.failureMessage === null &&
              step.failureDetails === null,
          )
          .map(step => step.stepKey),
      )
      if (DestroyStepKeys.some(key => !completed.has(key))) {
        throw new IncusError('Destroy completion requires committed safety and resource step accounting.', 'CONFLICT')
      }
    }
    return plan
  }

  private async finish(
    tx: DestroyTransaction<TDatabase>,
    locked: LockedDestroy,
  ): Promise<DestroyCapsuleTerminalResult> {
    const tables = this.persistence.tables
    const now = new Date()
    const [operation] = await tx
      .update(tables.capsuleOperations)
      .set({ status: 'completed', completedAt: now, updatedAt: now })
      .where(
        and(
          eq(tables.capsuleOperations.id, locked.operation.id),
          eq(tables.capsuleOperations.status, 'running'),
        ),
      )
      .returning()
    const [capsule] = await tx
      .update(tables.capsules)
      .set({ lifecycleStatus: 'destroyed', destroyedAt: now, updatedAt: now })
      .where(eq(tables.capsules.id, locked.capsule.id))
      .returning()
    const branches = await tx
      .update(tables.capsuleBranches)
      .set({
        status: 'destroyed',
        runtimeIp: null,
        runtimeErrorCode: null,
        runtimeErrorMessage: null,
        runtimeErrorDetails: null,
        runtimeErrorAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(tables.capsuleBranches.capsuleId, locked.operation.capsuleId),
          eq(tables.capsuleBranches.ownerId, locked.operation.ownerId),
        ),
      )
      .returning()
    await tx
      .update(tables.capsuleRouteAliases)
      .set({
        status: 'retired',
        lastOperationId: locked.operation.id,
        updatedAt: now,
      })
      .where(eq(tables.capsuleRouteAliases.capsuleId, locked.operation.capsuleId))
    if (!operation || !capsule || branches.length !== locked.branches.length) {
      throw new IncusError('Destroy completion did not update its complete aggregate.', 'CONFLICT')
    }
    return this.terminal({ operation, capsule, branches })
  }

  private async assertRetention(tx: DestroyTransaction<TDatabase>, ownerId: string, capsuleId: string) {
    const snapshots = this.persistence.tables.capsuleSnapshots
    const [snapshot] = await tx
      .select({ id: snapshots.id })
      .from(snapshots)
      .where(eq(snapshots.capsuleId, capsuleId))
      .limit(1)
    if (snapshot) {
      throw new IncusError('Capsule cannot be destroyed while committed snapshots remain.', 'CONFLICT', {
        snapshotId: snapshot.id,
        policy: 'snapshot_retention_deletion_not_implemented',
      })
    }
    await this.routes.assertDestroyable(tx, ownerId, capsuleId)
  }

  private assertExecution(locked: LockedDestroy, status: 'accepted' | 'running'): void {
    const { operation, capsule, branches } = locked
    this.assertForcePolicy(operation)
    if (
      operation.status !== status ||
      operation.completedAt !== null ||
      operation.failedAt !== null ||
      operation.failureCode !== null ||
      operation.failureMessage !== null ||
      operation.failureDetails !== null ||
      (status === 'accepted' &&
        (operation.executionStartedAt !== null || operation.providerMutationStartedAt !== null)) ||
      (status === 'running' && operation.executionStartedAt === null) ||
      capsule.lifecycleStatus !== 'destroying' ||
      capsule.destroyedAt !== null ||
      (!operation.destroyForce && capsule.archivedAt === null)
    ) {
      throw new IncusError('Destroy operation does not match its durable execution fence.', 'CONFLICT')
    }
    this.assertLineage(branches, operation.ownerId, operation.capsuleId, operation.destroyForce, 'execution')
  }

  private assertLineage(
    branches: readonly DestroyBranch[],
    ownerId: string,
    capsuleId: string,
    force: boolean,
    phase: 'acceptance' | 'execution',
  ): void {
    const valid =
      branches.length > 0 &&
      branches.filter(branch => branch.isRootBranch).length === 1 &&
      branches.every(branch => {
        if (branch.ownerId !== ownerId || branch.capsuleId !== capsuleId) {
          return false
        }
        if (phase === 'acceptance') {
          return force || branch.status === 'offline'
        }
        return branch.status === 'destroying' || (force && branch.status === 'destroyed')
      })
    if (!valid) {
      throw new IncusError('Destroy requires complete owner-consistent branch lineage and lifecycle fences.', 'CONFLICT')
    }
  }

  private assertForcePolicy(operation: DestroyOperation): void {
    if (!operation.destroyForce) {
      if (operation.destroyForceReason !== null || operation.destroyForceAcknowledged) {
        throw new IncusError('Normal destroy contains force-only audit evidence.', 'CONFLICT')
      }
      return
    }
    const reason = operation.destroyForceReason
    if (
      operation.actorType !== 'user' ||
      !operation.destroyForceAcknowledged ||
      reason === null ||
      reason.length < 1 ||
      reason.length > 2000 ||
      reason !== reason.trim()
    ) {
      throw new IncusError('Force destroy lacks valid persisted user-authored audit evidence.', 'CONFLICT')
    }
  }

  private async lock(tx: DestroyTransaction<TDatabase>, operationId: string): Promise<LockedDestroy> {
    const locked = await lockOperation<TDatabase>(tx, this.persistence.tables, operationId)
    const branches = await lockBranches<TDatabase>(tx, this.persistence.tables, locked.operation.capsuleId)
    return { ...locked, branches }
  }

  private async replay(input: AcceptDestroyCapsuleOperationInput): Promise<DestroyCapsuleRepositoryResult | null> {
    return await this.persistence.db.transaction(async tx => {
      // Replay reads remain on the caller's transaction and connection.
      await lockCapsule<TDatabase>(tx, this.persistence.tables, input.ownerId, input.capsuleId)
      return await this.findReplay(tx, input)
    })
  }

  private async findReplay(
    tx: DestroyTransaction<TDatabase>,
    input: AcceptDestroyCapsuleOperationInput,
  ): Promise<DestroyCapsuleRepositoryResult | null> {
    const operations = this.persistence.tables.capsuleOperations
    const [operation] = await tx
      .select()
      .from(operations)
      .where(and(eq(operations.ownerId, input.ownerId), eq(operations.idempotencyKey, input.idempotencyKey)))
      .limit(1)
    if (!operation) {
      return null
    }
    assertOperationReplayIdentity(
      {
        id: operation.id,
        type: operation.type,
        requestHash: operation.requestHash,
        actor: { type: operation.actorType, id: operation.actorId },
      },
      {
        operationType: 'destroy',
        actor: input.actor,
        requestHash: input.requestHash,
        requestDescription: 'capsule destroy',
      },
    )
    if (operation.capsuleId !== input.capsuleId) {
      throw new IncusError('Destroy replay belongs to another capsule.', 'CONFLICT')
    }
    const locked = await this.lock(tx, operation.id)
    this.assertForcePolicy(locked.operation)
    return this.result(locked, false, true)
  }

  private result(
    locked: LockedDestroy,
    newlyAccepted: boolean,
    replayed: boolean,
  ): DestroyCapsuleRepositoryResult {
    return {
      ...this.terminal(locked),
      newlyAccepted,
      receipt: CapsuleDestroyReceiptSchema.parse({
        operationId: locked.operation.id,
        operationType: 'destroy',
        operationStatus: locked.operation.status,
        capsuleId: locked.operation.capsuleId,
        replayed,
      }),
    }
  }

  private terminal(locked: LockedDestroy): DestroyCapsuleTerminalResult {
    return {
      operation: toCapsuleOperationTransition({
        ownerId: locked.operation.ownerId,
        operationId: locked.operation.id,
        operationType: 'destroy',
        operationStatus: locked.operation.status,
        capsuleId: locked.operation.capsuleId,
      }),
      capsule: toCapsuleLifecycleState({
        capsuleId: locked.capsule.id,
        lifecycleStatus: locked.capsule.lifecycleStatus,
        archivedAt: locked.capsule.archivedAt,
        destroyedAt: locked.capsule.destroyedAt,
      }),
      branches: locked.branches
        .filter(branch => branch.ownerId === locked.operation.ownerId)
        .map(branch => ({
          id: branch.id,
          capsuleId: branch.capsuleId,
          name: branch.name,
          status: branch.status,
        })),
    }
  }
}
