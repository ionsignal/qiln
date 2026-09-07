import { and, eq, inArray } from 'drizzle-orm'
import { CapsuleOperationStatus, type CapsulePersistence, type CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError } from '../../../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from '../../../failures'
import { toJsonObject } from '../../../persistence/json'
import * as policy from '../policy'
import type { BranchFailureInput, BranchOperationType, BranchTerminalResult, LockedBranchOperation } from '../types'
import type { BranchLocks, BranchTransaction } from './locks'

const NONTERMINAL_STATUSES = [CapsuleOperationStatus.ACCEPTED, CapsuleOperationStatus.RUNNING] as const

/**
 * Classifies runtime failures from locked durable evidence.
 *
 * Live failure always returns a terminal result or throws. Abandonment alone
 * returns null when another transition has already terminalized the operation.
 */
export class BranchClassificationPersistence<
  TOperation extends BranchOperationType,
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly locks: BranchLocks<TOperation, TDatabase, TTables>,
  ) {}

  public async fail(input: BranchFailureInput): Promise<BranchTerminalResult> {
    return await this.persistence.db.transaction(async tx => {
      const scope = await this.locks.load(tx, input.operationId)
      if (!policy.isNonterminal(scope.operation.status)) {
        throw new IncusError('Branch runtime operation is already terminal.', 'CONFLICT', {
          operationId: scope.operation.id,
          operationType: this.locks.type,
          operationStatus: scope.operation.status,
        })
      }
      return await this.persist(tx, scope, input, 'live')
    })
  }

  public async classifyAbandoned(operationId: string): Promise<BranchTerminalResult | null> {
    return await this.persistence.db.transaction(async tx => {
      const scope = await this.locks.load(tx, operationId)
      if (!policy.isNonterminal(scope.operation.status)) {
        return null
      }
      return await this.persist(
        tx,
        scope,
        {
          operationId,
          error: new IncusError('Branch runtime operation was abandoned by a previous Worker process.', 'API_ERROR', {
            operationId,
            operationType: this.locks.type,
            policy: 'never_resume_branch_runtime_after_worker_restart',
          }),
          phase: 'startup_abandoned_operation_classification',
          disposition: 'pre_provider',
        },
        'abandoned',
      )
    })
  }

  private async persist(
    tx: BranchTransaction<TDatabase>,
    scope: LockedBranchOperation,
    input: BranchFailureInput,
    origin: 'live' | 'abandoned',
  ): Promise<BranchTerminalResult> {
    const decision = policy.classify(scope, this.locks.type, input, origin)
    const { operation, branch } = scope
    const { capsuleOperations, capsuleBranches } = this.persistence.tables
    if (!decision.cleanupRequired && (branch === null || decision.branchStatus === null)) {
      throw new IncusError('Safe branch runtime failure requires a restorable, verified branch target.', 'CONFLICT', {
        operationId: operation.id,
      })
    }
    const details = createFailureDetails(input.error, {
      operationId: operation.id,
      operationType: this.locks.type,
      capsuleId: operation.capsuleId,
      branchId: scope.extension?.branchId ?? null,
      phase: input.phase,
      requestedDisposition: input.disposition,
      classification: decision.cleanupRequired ? 'branch_runtime_cleanup_required' : 'branch_runtime_failed',
      providerIntentRecorded: operation.providerMutationStartedAt !== null,
      identityValid: decision.identityValid,
      runtimeObservationProvided: input.runtimeIp !== undefined,
      abandoned: origin === 'abandoned',
      reasons: decision.reasons,
    })
    const now = new Date()
    const [terminalOperation] = await tx
      .update(capsuleOperations)
      .set({
        status: decision.cleanupRequired ? CapsuleOperationStatus.CLEANUP_REQUIRED : CapsuleOperationStatus.FAILED,
        failedAt: now,
        failureCode: failureCodeFromUnknown(input.error),
        failureMessage: failureMessageFromUnknown(
          input.error,
          decision.cleanupRequired
            ? 'Branch runtime operation requires manual cleanup and inspection.'
            : 'Branch runtime operation failed.',
        ),
        failureDetails: details === undefined ? null : toJsonObject(details, 'branch runtime failure details'),
        updatedAt: now,
      })
      .where(
        and(
          eq(capsuleOperations.id, operation.id),
          eq(capsuleOperations.type, this.locks.type),
          inArray(capsuleOperations.status, NONTERMINAL_STATUSES),
        ),
      )
      .returning()
    if (!terminalOperation) {
      throw new IncusError('Failed to classify the branch runtime operation.', 'CONFLICT', {
        operationId: operation.id,
      })
    }
    let committedBranch = decision.identityValid ? branch : null
    let branchChanged = false
    if (branch !== null && decision.branchStatus !== null) {
      const runtimeIp =
        decision.branchStatus === 'online' ? (input.runtimeIp === undefined ? branch.runtimeIp : input.runtimeIp) : null
      const [updated] = await tx
        .update(capsuleBranches)
        .set({
          status: decision.branchStatus,
          runtimeIp,
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleBranches.id, branch.id),
            eq(capsuleBranches.ownerId, operation.ownerId),
            eq(capsuleBranches.capsuleId, operation.capsuleId),
            eq(capsuleBranches.status, branch.status),
          ),
        )
        .returning()
      if (!updated) {
        throw new IncusError('Failed to classify the branch state after runtime failure.', 'CONFLICT', {
          operationId: operation.id,
          branchId: branch.id,
        })
      }
      committedBranch = updated
      branchChanged = updated.status !== branch.status
    }
    return {
      operation: policy.transition(terminalOperation),
      branch: committedBranch === null ? null : policy.state(committedBranch),
      branchChanged,
    }
  }
}
