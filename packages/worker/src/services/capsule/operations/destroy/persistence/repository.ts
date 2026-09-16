import { and, eq, inArray, isNull } from 'drizzle-orm'
import {
  CapsuleDestroyReceiptSchema,
  SshCapsuleAccessRevocationOutputSchema,
  digestCanonicalJsonValue,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError, isUniqueConstraintViolation } from '../../../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from '../../../failures'
import { toJsonObject } from '../../../persistence/json'
import { assertOperationReplayIdentity, toCapsuleLifecycleState, toCapsuleOperationTransition } from '../../shared'
import { lockBranches, lockCapsule, lockOperation, type DestroyTransaction } from './locks'
import type { DestroyPlanner } from '../plan'
import type { DestroyTargets, DestroyTargetState } from './targets'
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
 * Each attempt owns its target plan, access evidence, and deletion outcomes.
 * Historical resource accounting remains untouched.
 *
 * Retirement is conservative availability state. Failure never automatically
 * makes a retired snapshot usable again.
 */
export class DestroyCapsuleOperationRepository<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly planner: DestroyPlanner<TDatabase, TTables>,
    private readonly targets: DestroyTargets<TDatabase, TTables>,
  ) {}

  public async acceptOrReplay(input: AcceptDestroyCapsuleOperationInput): Promise<DestroyCapsuleRepositoryResult> {
    const accept = async (): Promise<DestroyCapsuleRepositoryResult> => {
      return await this.persistence.db.transaction(async tx => {
        const t = this.persistence.tables
        const capsule = await lockCapsule<TDatabase>(tx, t, input.ownerId, input.capsuleId)
        const replay = await this.replay(tx, input, capsule)
        if (replay) {
          return replay
        }
        const [active] = await tx.select({ id: t.capsuleOperations.id }).from(t.capsuleOperations)
          .where(and(
            eq(t.capsuleOperations.capsuleId, capsule.id),
            inArray(t.capsuleOperations.status, ['accepted', 'running']),
          )).limit(1)
        if (active) {
          throw new IncusError('Capsule already has a nonterminal operation.', 'CONFLICT')
        }
        if (capsule.lifecycleStatus === 'destroyed' || capsule.destroyedAt !== null) {
          throw new IncusError('Destroyed capsules cannot be destroyed again.', 'CONFLICT')
        }
        const branches = await lockBranches<TDatabase>(tx, t, capsule.id)
        this.assertBranches(branches, input.ownerId, capsule.id)
        if (!input.force && (
          capsule.lifecycleStatus !== 'active' ||
          capsule.archivedAt === null ||
          branches.some(branch => branch.status !== 'offline')
        )) {
          throw new IncusError('Normal destroy requires an archived capsule with every branch offline.', 'CONFLICT')
        }
        const now = new Date()
        const [operation] = await tx.insert(t.capsuleOperations).values({
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
        }).returning()
        if (!operation) {
          throw new IncusError('Failed to accept capsule destroy.', 'API_ERROR')
        }
        this.assertForce(operation)
        const [destroying] = await tx.update(t.capsules)
          .set({ lifecycleStatus: 'destroying', updatedAt: now })
          .where(eq(t.capsules.id, capsule.id)).returning()
        if (!destroying) {
          throw new IncusError('Failed to fence the capsule for destroy.', 'CONFLICT')
        }
        await tx.update(t.capsuleBranches)
          .set({ status: 'destroying', runtimeIp: null, updatedAt: now })
          .where(and(
            eq(t.capsuleBranches.capsuleId, capsule.id),
            inArray(t.capsuleBranches.id, branches.filter(branch => branch.status !== 'destroyed').map(branch => branch.id)),
          ))
        return this.result({
          operation,
          capsule: destroying,
          branches: await lockBranches<TDatabase>(tx, t, capsule.id),
        }, true)
      })
    }
    try {
      return await accept()
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) {
        throw error
      }
      return await this.persistence.db.transaction(async tx => {
        const capsule = await lockCapsule<TDatabase>(tx, this.persistence.tables, input.ownerId, input.capsuleId)
        const replay = await this.replay(tx, input, capsule)
        if (!replay) {
          throw new IncusError('Destroy conflicts with another durable capsule operation.', 'CONFLICT')
        }
        return replay
      })
    }
  }

  public async claim(operationId: string): Promise<DestroyCapsuleTerminalResult['operation']> {
    return await this.persistence.db.transaction(async tx => {
      const locked = await this.lock(tx, operationId)
      this.assertExecution(locked, 'accepted')
      const operations = this.persistence.tables.capsuleOperations
      const now = new Date()
      const [operation] = await tx.update(operations)
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
   * Planning and target persistence precede retirement and all external work.
   * A crash between these transactions is classified, never resumed.
   */
  public async prepare(operationId: string): Promise<DestroyExecution> {
    const plan = await this.persistence.db.transaction(async tx => {
      const locked = await this.lock(tx, operationId)
      this.assertExecution(locked, 'running')
      if (locked.operation.providerMutationStartedAt !== null) {
        throw new IncusError('Destroy planning cannot resume after provider intent.', 'CONFLICT')
      }
      return await this.planner.build(tx, locked.operation, locked.branches)
    })
    await this.targets.plan(operationId, plan.document)
    const state = await this.persistence.db.transaction(async tx => {
      const locked = await this.lock(tx, operationId)
      this.assertExecution(locked, 'running')
      const state = await this.targets.load(tx, locked.operation, locked.capsule)
      if (state.operation.providerMutationStartedAt !== null) {
        throw new IncusError('Destroy retirement must precede provider intent.', 'CONFLICT')
      }
      const t = this.persistence.tables
      const now = new Date()
      await tx.update(t.capsuleSnapshots).set({
        retiredAt: now,
        retiredByOperationId: operationId,
      }).where(and(
        eq(t.capsuleSnapshots.capsuleId, locked.capsule.id),
        isNull(t.capsuleSnapshots.retiredAt),
      ))
      await tx.update(t.capsuleBranchPreviews).set({
        withdrawalRequestedAt: now,
        updatedAt: now,
      }).where(and(
        eq(t.capsuleBranchPreviews.capsuleId, locked.capsule.id),
        isNull(t.capsuleBranchPreviews.withdrawalRequestedAt),
      ))
      // Committed heads remain until this attempt positively withdraws ingress.
      await tx.update(t.capsuleRouteAliases).set({
        status: 'mutating',
        mutationOperationId: operationId,
        updatedAt: now,
      }).where(eq(t.capsuleRouteAliases.capsuleId, locked.capsule.id))
      return state
    })
    const byDigest = new Map(state.targets.map(target => [target.targetDigest, target]))
    const ordered = plan.ordered.map(resource => {
      const target = byDigest.get(digestCanonicalJsonValue(resource.target))
      if (!target) {
        throw new IncusError('Destroy execution order does not match its persisted target plan.', 'CONFLICT')
      }
      return target
    })
    return {
      operationId,
      ownerId: state.operation.ownerId,
      capsuleId: state.operation.capsuleId,
      force: state.operation.destroyForce,
      targets: ordered,
    }
  }

  public async fence(operationId: string): Promise<void> {
    await this.persistence.db.transaction(async tx => {
      const locked = await this.lock(tx, operationId)
      this.assertExecution(locked, 'running')
      const state = await this.targets.load(tx, locked.operation, locked.capsule)
      this.assertAccess(state)
      const operations = this.persistence.tables.capsuleOperations
      const now = new Date()
      const [updated] = await tx.update(operations)
        .set({ providerMutationStartedAt: now, updatedAt: now })
        .where(and(eq(operations.id, operationId), isNull(operations.providerMutationStartedAt)))
        .returning({ id: operations.id })
      if (!updated) {
        throw new IncusError('Destroy provider intent was already recorded.', 'CONFLICT')
      }
    })
  }

  /**
   * Clears derived preview state and alias heads only after every planned
   * route obligation has a confirmed terminal outcome.
   */
  public async withdrawn(operationId: string): Promise<void> {
    await this.persistence.db.transaction(async tx => {
      const locked = await this.lock(tx, operationId)
      this.assertExecution(locked, 'running')
      const state = await this.targets.load(tx, locked.operation, locked.capsule)
      this.assertAccess(state)
      if (state.targets.some(target =>
        target.target.kind === 'route' && target.status !== 'absent' && target.status !== 'deleted',
      )) {
        throw new IncusError('Destroy ingress withdrawal remains unresolved.', 'CONFLICT')
      }
      const t = this.persistence.tables
      const now = new Date()
      await tx.update(t.capsuleBranchPreviews).set({
        status: 'inactive',
        withdrawalRequestedAt: now,
        currentRuntimeIp: null,
        currentConfigurationKey: null,
        currentConfigurationDigest: null,
        currentConfiguration: null,
        pendingRuntimeIp: null,
        pendingConfigurationKey: null,
        pendingConfigurationDigest: null,
        pendingConfiguration: null,
        applyIntentAt: null,
        appliedAt: null,
        verificationIntentAt: null,
        verificationEvidence: null,
        verifiedAt: null,
        removeIntentAt: null,
        failureCode: null,
        failureMessage: null,
        failureDetails: null,
        failureAt: null,
        updatedAt: now,
      }).where(eq(t.capsuleBranchPreviews.capsuleId, locked.capsule.id))
      const aliases = await tx.select({ id: t.capsuleRouteAliases.id }).from(t.capsuleRouteAliases)
        .where(eq(t.capsuleRouteAliases.capsuleId, locked.capsule.id)).for('update')
      if (aliases.length > 0) {
        await tx.delete(t.capsuleRouteHeads)
          .where(inArray(t.capsuleRouteHeads.aliasId, aliases.map(alias => alias.id)))
      }
      await tx.update(t.capsuleRouteAliases).set({
        status: 'retired',
        mutationOperationId: null,
        lastOperationId: operationId,
        updatedAt: now,
      }).where(eq(t.capsuleRouteAliases.capsuleId, locked.capsule.id))
    })
  }

  public async complete(operationId: string): Promise<DestroyCapsuleTerminalResult> {
    return await this.persistence.db.transaction(async tx => {
      const locked = await this.lock(tx, operationId)
      this.assertExecution(locked, 'running')
      const state = await this.targets.load(tx, locked.operation, locked.capsule)
      this.assertAccess(state)
      if (state.targets.some(target => target.status !== 'absent' && target.status !== 'deleted')) {
        throw new IncusError('Destroy has unresolved provider obligations.', 'CONFLICT')
      }
      if (state.targets.some(target => target.status === 'deleted') && locked.operation.providerMutationStartedAt === null) {
        throw new IncusError('Destroy deletion outcomes lack this attempt’s provider fence.', 'CONFLICT')
      }
      const t = this.persistence.tables
      const previews = await tx.select().from(t.capsuleBranchPreviews)
        .where(eq(t.capsuleBranchPreviews.capsuleId, locked.capsule.id)).for('update')
      const aliases = await tx.select().from(t.capsuleRouteAliases)
        .where(eq(t.capsuleRouteAliases.capsuleId, locked.capsule.id)).for('update')
      const heads = aliases.length === 0 ? [] : await tx.select().from(t.capsuleRouteHeads)
        .where(inArray(t.capsuleRouteHeads.aliasId, aliases.map(alias => alias.id)))
      const [usableSnapshot] = await tx.select({ id: t.capsuleSnapshots.id }).from(t.capsuleSnapshots)
        .where(and(eq(t.capsuleSnapshots.capsuleId, locked.capsule.id), isNull(t.capsuleSnapshots.retiredAt))).limit(1)
      if (
        previews.some(preview => preview.status !== 'inactive') ||
        aliases.some(alias => alias.status !== 'retired' || alias.mutationOperationId !== null) ||
        heads.length > 0 ||
        usableSnapshot
      ) {
        throw new IncusError('Destroy access, ingress, or snapshot retirement is incomplete.', 'CONFLICT')
      }
      const now = new Date()
      const [operation] = await tx.update(t.capsuleOperations)
        .set({ status: 'completed', completedAt: now, updatedAt: now })
        .where(and(eq(t.capsuleOperations.id, operationId), eq(t.capsuleOperations.status, 'running'))).returning()
      const [capsule] = await tx.update(t.capsules)
        .set({ lifecycleStatus: 'destroyed', destroyedAt: now, updatedAt: now })
        .where(eq(t.capsules.id, locked.capsule.id)).returning()
      const branches = await tx.update(t.capsuleBranches)
        .set({ status: 'destroyed', runtimeIp: null, updatedAt: now })
        .where(eq(t.capsuleBranches.capsuleId, locked.capsule.id)).returning()
      if (!operation || !capsule || branches.length !== locked.branches.length) {
        throw new IncusError('Destroy completion did not update its complete aggregate.', 'CONFLICT')
      }
      return this.terminal({ operation, capsule, branches })
    })
  }

  public async classifyExecutionFailure(
    operationId: string,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<DestroyCapsuleTerminalResult | null> {
    return await this.classify(operationId, error, context)
  }

  public async classifyAbandoned(operationId: string): Promise<DestroyCapsuleTerminalResult | null> {
    return await this.classify(
      operationId,
      new IncusError('Destroy was abandoned by a previous Worker process.', 'API_ERROR'),
      { phase: 'startup_abandoned_operation_classification', policy: 'never_resume_destroy' },
    )
  }

  private async classify(
    operationId: string,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<DestroyCapsuleTerminalResult | null> {
    return await this.persistence.db.transaction(async tx => {
      const locked = await this.lock(tx, operationId)
      if (locked.operation.status !== 'accepted' && locked.operation.status !== 'running') {
        return null
      }
      const t = this.persistence.tables
      const [plan] = await tx.select({ operationId: t.capsuleDestroyOperations.operationId })
        .from(t.capsuleDestroyOperations).where(eq(t.capsuleDestroyOperations.operationId, operationId)).limit(1)
      const restore = !locked.operation.destroyForce &&
        locked.operation.providerMutationStartedAt === null &&
        plan === undefined &&
        locked.capsule.lifecycleStatus === 'destroying' &&
        locked.capsule.archivedAt !== null &&
        locked.branches.every(branch => branch.status === 'destroying')
      const now = new Date()
      const details = createFailureDetails(error, {
        ...context,
        force: locked.operation.destroyForce,
        providerIntentRecorded: locked.operation.providerMutationStartedAt !== null,
        classification: restore ? 'safe_pre_provider_failure' : 'cleanup_required',
      }) ?? {}
      await tx.update(t.capsuleDestroyResources)
        .set({ status: 'unresolved', verifiedAt: null, updatedAt: now })
        .where(and(
          eq(t.capsuleDestroyResources.operationId, operationId),
          inArray(t.capsuleDestroyResources.status, ['planned', 'deleting']),
        ))
      const [operation] = await tx.update(t.capsuleOperations).set({
        status: restore ? 'failed' : 'cleanup_required',
        completedAt: null,
        failedAt: now,
        failureCode: failureCodeFromUnknown(error),
        failureMessage: failureMessageFromUnknown(error),
        failureDetails: toJsonObject(details, 'destroy failure'),
        updatedAt: now,
      }).where(eq(t.capsuleOperations.id, operationId)).returning()
      let capsule = locked.capsule
      if (capsule.lifecycleStatus !== 'destroyed') {
        const [updated] = await tx.update(t.capsules)
          .set({ lifecycleStatus: restore ? 'active' : 'cleanup_required', updatedAt: now })
          .where(eq(t.capsules.id, capsule.id)).returning()
        if (!updated) {
          throw new IncusError('Destroy failure could not fence the capsule.', 'CONFLICT')
        }
        capsule = updated
      }
      const mutable = locked.branches.filter(branch =>
        branch.ownerId === locked.operation.ownerId && branch.status !== 'destroyed',
      )
      if (mutable.length > 0) {
        await tx.update(t.capsuleBranches)
          .set({ status: restore ? 'offline' : 'cleanup_required', runtimeIp: null, updatedAt: now })
          .where(inArray(t.capsuleBranches.id, mutable.map(branch => branch.id)))
      }
      await tx.update(t.capsuleRouteAliases).set({
        status: 'cleanup_required',
        mutationOperationId: null,
        lastOperationId: operationId,
        updatedAt: now,
      }).where(and(
        eq(t.capsuleRouteAliases.capsuleId, locked.capsule.id),
        eq(t.capsuleRouteAliases.mutationOperationId, operationId),
      ))
      if (!operation) {
        throw new IncusError('Destroy failure could not be persisted.', 'CONFLICT')
      }
      return this.terminal({
        operation,
        capsule,
        branches: await lockBranches<TDatabase>(tx, t, capsule.id),
      })
    })
  }

  private assertAccess(state: DestroyTargetState): void {
    const report = SshCapsuleAccessRevocationOutputSchema.safeParse(state.plan.sshRevocation)
    if (
      !report.success ||
      state.plan.sshRevokedAt === null ||
      report.data.capsuleId !== state.operation.capsuleId ||
      report.data.branchAccess.length !== state.plan.branchIds.length ||
      new Set(report.data.branchAccess.map(access => access.branchId)).size !== state.plan.branchIds.length ||
      report.data.branchAccess.some(access =>
        access.capsuleId !== state.operation.capsuleId ||
        access.state !== 'blocked' ||
        !state.plan.branchIds.includes(access.branchId),
      )
    ) {
      throw new IncusError('Destroy requires this attempt’s complete SSH revocation and relay closure evidence.', 'CONFLICT')
    }
  }

  private assertExecution(locked: LockedDestroy, status: 'accepted' | 'running'): void {
    const { operation, capsule, branches } = locked
    this.assertForce(operation)
    this.assertBranches(branches, operation.ownerId, operation.capsuleId)
    if (
      operation.status !== status ||
      operation.completedAt !== null ||
      operation.failedAt !== null ||
      operation.failureCode !== null ||
      operation.failureMessage !== null ||
      operation.failureDetails !== null ||
      (status === 'accepted' && (operation.executionStartedAt !== null || operation.providerMutationStartedAt !== null)) ||
      (status === 'running' && operation.executionStartedAt === null) ||
      capsule.lifecycleStatus !== 'destroying' ||
      capsule.destroyedAt !== null ||
      (!operation.destroyForce && capsule.archivedAt === null) ||
      branches.some(branch => branch.status !== 'destroying' && branch.status !== 'destroyed')
    ) {
      throw new IncusError('Destroy does not match its current execution fence.', 'CONFLICT')
    }
  }

  private assertBranches(branches: readonly DestroyBranch[], ownerId: string, capsuleId: string): void {
    if (
      branches.length === 0 ||
      branches.filter(branch => branch.isRootBranch).length !== 1 ||
      branches.some(branch => branch.ownerId !== ownerId || branch.capsuleId !== capsuleId)
    ) {
      throw new IncusError('Destroy requires complete owner-consistent branch lineage.', 'CONFLICT')
    }
  }

  private assertForce(operation: DestroyOperation): void {
    if (!operation.destroyForce) {
      if (operation.destroyForceReason !== null || operation.destroyForceAcknowledged) {
        throw new IncusError('Normal destroy contains force-only evidence.', 'CONFLICT')
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
      throw new IncusError('Force destroy lacks valid persisted user-authored confirmation.', 'CONFLICT')
    }
  }

  private async lock(tx: DestroyTransaction<TDatabase>, operationId: string): Promise<LockedDestroy> {
    const locked = await lockOperation<TDatabase>(tx, this.persistence.tables, operationId)
    return {
      ...locked,
      branches: await lockBranches<TDatabase>(tx, this.persistence.tables, locked.operation.capsuleId),
    }
  }

  private async replay(
    tx: DestroyTransaction<TDatabase>,
    input: AcceptDestroyCapsuleOperationInput,
    capsule: DestroyCapsule,
  ): Promise<DestroyCapsuleRepositoryResult | null> {
    const operations = this.persistence.tables.capsuleOperations
    const [operation] = await tx.select().from(operations).where(and(
      eq(operations.ownerId, input.ownerId),
      eq(operations.idempotencyKey, input.idempotencyKey),
    )).limit(1)
    if (!operation) {
      return null
    }
    assertOperationReplayIdentity({
      id: operation.id,
      type: operation.type,
      requestHash: operation.requestHash,
      actor: { type: operation.actorType, id: operation.actorId },
    }, {
      operationType: 'destroy',
      actor: input.actor,
      requestHash: input.requestHash,
      requestDescription: 'capsule destroy',
    })
    if (operation.capsuleId !== capsule.id) {
      throw new IncusError('Destroy replay belongs to another capsule.', 'CONFLICT')
    }
    return this.result({
      operation,
      capsule,
      branches: await lockBranches<TDatabase>(tx, this.persistence.tables, capsule.id),
    }, false)
  }

  private result(locked: LockedDestroy, newlyAccepted: boolean): DestroyCapsuleRepositoryResult {
    return {
      ...this.terminal(locked),
      newlyAccepted,
      receipt: CapsuleDestroyReceiptSchema.parse({
        operationId: locked.operation.id,
        operationType: 'destroy',
        operationStatus: locked.operation.status,
        capsuleId: locked.operation.capsuleId,
        replayed: !newlyAccepted,
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
      branches: locked.branches.filter(branch => branch.ownerId === locked.operation.ownerId).map(branch => ({
        id: branch.id,
        capsuleId: branch.capsuleId,
        name: branch.name,
        status: branch.status,
      })),
    }
  }
}
