import { and, eq, isNull } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  type CapsuleBranchStatus,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError } from '../../../../../errors'
import type { PreviewGate } from '../../../routing/preview/gate'
import * as policy from '../policy'
import type {
  BranchExecutionInput,
  BranchOperationType,
  BranchState,
  BranchTerminalResult,
  ValidatedBranchOperation,
} from '../types'
import type { BranchLocks, BranchTransaction } from './locks'

/**
 * Owns claim, Incus intent, runtime confirmation, and successful completion.
 *
 * Start's intermediate online write and stop's preview prerequisite remain
 * explicit. This capability performs no provider or Host SSH calls.
 */
export class BranchExecutionPersistence<
  TOperation extends BranchOperationType,
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly locks: BranchLocks<TOperation, TDatabase, TTables>,
    private readonly previews?: PreviewGate<TDatabase, TTables>,
  ) {
    if (locks.type === CapsuleOperationType.BRANCH_STOP && !previews) {
      throw new Error('Branch stop persistence requires the transactional preview gate.')
    }
  }

  public async load(operationId: string): Promise<BranchExecutionInput> {
    return await this.persistence.db.transaction(async tx => {
      const scope = await this.ready(tx, operationId, CapsuleOperationStatus.ACCEPTED, 'absent', [
        policy.definitions[this.locks.type].accepted,
      ])
      return {
        operationId: scope.operation.id,
        ownerId: scope.operation.ownerId,
        capsuleId: scope.operation.capsuleId,
        branchId: scope.extension.branchId,
        branchName: scope.extension.branchName,
      }
    })
  }

  public async claim(operationId: string) {
    const operations = this.persistence.tables.capsuleOperations
    return await this.persistence.db.transaction(async tx => {
      const scope = await this.ready(tx, operationId, CapsuleOperationStatus.ACCEPTED, 'absent', [
        policy.definitions[this.locks.type].accepted,
      ])
      const now = new Date()
      const [claimed] = await tx
        .update(operations)
        .set({
          status: CapsuleOperationStatus.RUNNING,
          executionStartedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(operations.id, scope.operation.id),
            eq(operations.type, this.locks.type),
            eq(operations.status, CapsuleOperationStatus.ACCEPTED),
            isNull(operations.providerMutationStartedAt),
          ),
        )
        .returning()
      if (!claimed) {
        throw new IncusError('Branch runtime operation claim conflicted with another transition.', 'CONFLICT', {
          operationId,
          operationType: this.locks.type,
        })
      }
      return policy.transition(claimed)
    })
  }

  /**
   * This fence guards the Incus start/stop call. Stop's preceding preview
   * withdrawal retains its own provider-intent accounting.
   */
  public async intent(operationId: string): Promise<void> {
    const operations = this.persistence.tables.capsuleOperations
    await this.persistence.db.transaction(async tx => {
      const scope = await this.ready(tx, operationId, CapsuleOperationStatus.RUNNING, 'absent', [
        policy.definitions[this.locks.type].accepted,
      ])
      if (this.locks.type === CapsuleOperationType.BRANCH_STOP) {
        const previews = this.previews
        if (!previews) {
          throw new Error('Branch stop persistence has no transactional preview gate.')
        }
        await previews.assertBranchWithdrawn(tx, scope.operation.ownerId, scope.operation.capsuleId, scope.branch.id)
      }
      const now = new Date()
      const [updated] = await tx
        .update(operations)
        .set({
          providerMutationStartedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(operations.id, scope.operation.id),
            eq(operations.type, this.locks.type),
            eq(operations.status, CapsuleOperationStatus.RUNNING),
            isNull(operations.providerMutationStartedAt),
          ),
        )
        .returning({
          id: operations.id,
        })
      if (!updated) {
        throw new IncusError('Failed to record branch runtime provider intent.', 'CONFLICT', {
          operationId,
          operationType: this.locks.type,
        })
      }
    })
  }

  /**
   * Start persists positive online observation before SSH enablement. The
   * operation remains running until its explicit executor finishes
   * coordination.
   */
  public async online(operationId: string, runtimeIp: string | null): Promise<BranchState> {
    if (this.locks.type !== CapsuleOperationType.BRANCH_START) {
      throw new IncusError('Only branch start may persist intermediate online confirmation.', 'CONFLICT', {
        operationId,
        operationType: this.locks.type,
      })
    }
    const branches = this.persistence.tables.capsuleBranches
    return await this.persistence.db.transaction(async tx => {
      const scope = await this.ready(tx, operationId, CapsuleOperationStatus.RUNNING, 'recorded', ['starting'])
      const [online] = await tx
        .update(branches)
        .set({
          status: 'online',
          runtimeIp,
          runtimeErrorCode: null,
          runtimeErrorMessage: null,
          runtimeErrorDetails: null,
          runtimeErrorAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(branches.id, scope.branch.id),
            eq(branches.ownerId, scope.operation.ownerId),
            eq(branches.capsuleId, scope.operation.capsuleId),
            eq(branches.status, 'starting'),
          ),
        )
        .returning()
      if (!online) {
        throw new IncusError('Confirmed branch start state conflicted with another transition.', 'CONFLICT', {
          operationId,
          branchId: scope.branch.id,
        })
      }
      return policy.state(online)
    })
  }

  /**
   * Stop commits offline state and operation completion together. Start has
   * already committed online state and completes only its operation here.
   */
  public async complete(operationId: string): Promise<BranchTerminalResult> {
    const definition = policy.definitions[this.locks.type]
    const stopping = this.locks.type === CapsuleOperationType.BRANCH_STOP
    const { capsuleOperations, capsuleBranches } = this.persistence.tables
    return await this.persistence.db.transaction(async tx => {
      const scope = await this.ready(tx, operationId, CapsuleOperationStatus.RUNNING, 'recorded', [
        stopping ? definition.accepted : definition.successful,
      ])
      const now = new Date()
      let committedBranch = scope.branch
      if (stopping) {
        const [offline] = await tx
          .update(capsuleBranches)
          .set({
            status: 'offline',
            runtimeIp: null,
            runtimeErrorCode: null,
            runtimeErrorMessage: null,
            runtimeErrorDetails: null,
            runtimeErrorAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(capsuleBranches.id, scope.branch.id),
              eq(capsuleBranches.ownerId, scope.operation.ownerId),
              eq(capsuleBranches.capsuleId, scope.operation.capsuleId),
              eq(capsuleBranches.status, 'stopping'),
            ),
          )
          .returning()
        if (!offline) {
          throw new IncusError('Failed to persist confirmed offline branch state.', 'CONFLICT', {
            operationId,
            branchId: scope.branch.id,
          })
        }
        committedBranch = offline
      }
      const [completed] = await tx
        .update(capsuleOperations)
        .set({
          status: CapsuleOperationStatus.COMPLETED,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleOperations.id, scope.operation.id),
            eq(capsuleOperations.type, this.locks.type),
            eq(capsuleOperations.status, CapsuleOperationStatus.RUNNING),
          ),
        )
        .returning()
      if (!completed) {
        throw new IncusError('Failed to complete the branch runtime operation.', 'CONFLICT', {
          operationId,
          operationType: this.locks.type,
        })
      }
      return {
        operation: policy.transition(completed),
        branch: policy.state(committedBranch),
        branchChanged: stopping,
      }
    })
  }

  private async ready(
    tx: BranchTransaction<TDatabase>,
    operationId: string,
    requiredStatus: typeof CapsuleOperationStatus.ACCEPTED | typeof CapsuleOperationStatus.RUNNING,
    intent: 'absent' | 'recorded',
    branchStatuses: readonly CapsuleBranchStatus[],
  ): Promise<ValidatedBranchOperation> {
    const scope = policy.identity(await this.locks.load(tx, operationId), this.locks.type)

    policy.assertActive(scope.capsule)

    const reasons = policy.inspectOperation(scope.operation)
    const providerIntentRecorded = scope.operation.providerMutationStartedAt !== null
    if (
      scope.operation.status !== requiredStatus ||
      providerIntentRecorded !== (intent === 'recorded') ||
      !branchStatuses.includes(scope.branch.status) ||
      reasons.length > 0
    ) {
      throw new IncusError('Branch runtime operation is not eligible for this execution boundary.', 'CONFLICT', {
        operationId,
        operationType: this.locks.type,
        operationStatus: scope.operation.status,
        requiredStatus,
        branchStatus: scope.branch.status,
        requiredBranchStatuses: [...branchStatuses],
        providerIntentRecorded,
        requiredProviderIntent: intent,
        reasons,
      })
    }
    return scope
  }
}
