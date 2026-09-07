import { and, eq } from 'drizzle-orm'
import { CapsuleOperationStatus, type CapsulePersistence, type CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError, isUniqueConstraintViolation } from '../../../../../errors'
import {
  assertOperationReplayIdentity,
  type CapsuleOperationReader,
  type PersistedCapsuleOperation,
} from '../../shared'
import * as policy from '../policy'
import type {
  AcceptBranchInput,
  BranchAcceptance,
  BranchOperationRow,
  BranchOperationType,
  ValidatedBranchOperation,
} from '../types'
import type { BranchLocks } from './locks'

type ReplayIdentity = Pick<
  PersistedCapsuleOperation,
  'id' | 'ownerId' | 'capsuleId' | 'type' | 'actor' | 'idempotencyKey' | 'requestHash'
>

/**
 * Owns actor-bound replay and atomic branch-operation acceptance.
 *
 * The capsule lock serializes same-capsule submissions. Replay is repeated
 * under that lock before mutable eligibility is inspected, so an identical
 * concurrent request receives its receipt instead of a branch-status conflict.
 */
export class BranchAcceptancePersistence<
  TOperation extends BranchOperationType,
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly locks: BranchLocks<TOperation, TDatabase, TTables>,
    private readonly reader: CapsuleOperationReader<TDatabase, TTables>,
  ) {}

  public async accept(input: AcceptBranchInput): Promise<BranchAcceptance<TOperation>> {
    const replay = await this.findReplay(input)
    if (replay) {
      return replay
    }
    const definition = policy.definitions[this.locks.type]
    const { capsuleBranches, capsuleOperations, capsuleBranchRuntimeOperations } = this.persistence.tables
    try {
      return await this.persistence.db.transaction(async tx => {
        const capsule = await this.locks.capsule(tx, input.ownerId, input.capsuleId)
        const existing = await this.locks.replay(tx, input.ownerId, input.idempotencyKey)
        if (existing) {
          this.assertReplay(this.replayIdentity(existing), input)
          const locked = await this.locks.operation(tx, capsule, existing)
          return this.replayed(locked, input)
        }

        policy.assertActive(capsule)

        const branch = await this.locks.branch(tx, input.branchId)
        if (!branch || branch.ownerId !== input.ownerId || branch.capsuleId !== input.capsuleId) {
          throw new IncusError('Capsule branch not found or access denied.', 'NOT_FOUND', {
            capsuleId: input.capsuleId,
            branchId: input.branchId,
          })
        }
        if (branch.status !== definition.initial) {
          throw new IncusError(`Capsule branch cannot ${definition.action} from '${branch.status}'.`, 'CONFLICT', {
            capsuleId: input.capsuleId,
            branchId: branch.id,
            branchName: branch.name,
            branchStatus: branch.status,
          })
        }
        const now = new Date()
        const [operation] = await tx
          .insert(capsuleOperations)
          .values({
            ownerId: input.ownerId,
            actorType: input.actor.type,
            actorId: input.actor.id,
            capsuleId: input.capsuleId,
            type: definition.type,
            status: CapsuleOperationStatus.ACCEPTED,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            acceptedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
        if (!operation) {
          throw new IncusError(`Failed to accept the branch ${definition.action} operation.`, 'API_ERROR')
        }
        const [extension] = await tx
          .insert(capsuleBranchRuntimeOperations)
          .values({
            operationId: operation.id,
            branchId: branch.id,
            branchName: branch.name,
          })
          .returning()
        if (!extension) {
          throw new IncusError('Failed to persist immutable branch runtime input.', 'API_ERROR', {
            operationId: operation.id,
            branchId: branch.id,
          })
        }
        const [acceptedBranch] = await tx
          .update(capsuleBranches)
          .set({
            status: definition.accepted,
            runtimeIp: definition.initial === 'offline' ? null : branch.runtimeIp,
            runtimeErrorCode: null,
            runtimeErrorMessage: null,
            runtimeErrorDetails: null,
            runtimeErrorAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(capsuleBranches.id, branch.id),
              eq(capsuleBranches.ownerId, input.ownerId),
              eq(capsuleBranches.capsuleId, input.capsuleId),
              eq(capsuleBranches.status, definition.initial),
            ),
          )
          .returning()
        if (!acceptedBranch) {
          throw new IncusError('Branch runtime acceptance conflicted with another transition.', 'CONFLICT', {
            operationId: operation.id,
            branchId: branch.id,
          })
        }
        const scope = policy.identity(
          {
            capsule,
            operation,
            extension,
            branch: acceptedBranch,
          },
          definition.type,
        )
        return this.result(scope, true)
      })
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) {
        throw error
      }
      const racedReplay = await this.findReplay(input)
      if (racedReplay) {
        return racedReplay
      }
      throw new IncusError(
        'The capsule already has a nonterminal operation or the idempotency key conflicts with another request.',
        'CONFLICT',
        {
          capsuleId: input.capsuleId,
          branchId: input.branchId,
          operationType: this.locks.type,
        },
      )
    }
  }

  private async findReplay(input: AcceptBranchInput): Promise<BranchAcceptance<TOperation> | null> {
    const existing = await this.reader.loadByOwnerAndIdempotencyKey(input.ownerId, input.idempotencyKey)
    if (!existing) {
      return null
    }

    this.assertReplay(existing, input)

    return await this.persistence.db.transaction(async tx => {
      const locked = await this.locks.load(tx, existing.id)
      return this.replayed(locked, input)
    })
  }

  private replayed(
    locked: Parameters<typeof policy.identity>[0],
    input: AcceptBranchInput,
  ): BranchAcceptance<TOperation> {
    this.assertReplay(this.replayIdentity(locked.operation), input)

    const scope = policy.identity(locked, this.locks.type)
    if (scope.extension.branchId !== input.branchId) {
      throw new IncusError('Branch runtime replay does not match the requested branch UUID.', 'CONFLICT', {
        operationId: scope.operation.id,
        branchId: input.branchId,
      })
    }
    // Replay describes an existing operation. Current lifecycle and runtime
    // eligibility are deliberately irrelevant to returning its receipt.
    return this.result(scope, false)
  }

  private assertReplay(operation: ReplayIdentity, input: AcceptBranchInput): void {
    assertOperationReplayIdentity(operation, {
      operationType: this.locks.type,
      actor: input.actor,
      requestHash: input.requestHash,
      requestDescription: `branch ${policy.definitions[this.locks.type].action}`,
    })

    if (
      operation.ownerId !== input.ownerId ||
      operation.capsuleId !== input.capsuleId ||
      operation.idempotencyKey !== input.idempotencyKey
    ) {
      throw new IncusError('Branch runtime replay does not match its owner, capsule, or idempotency key.', 'CONFLICT', {
        operationId: operation.id,
        capsuleId: input.capsuleId,
      })
    }
  }

  private replayIdentity(operation: BranchOperationRow): ReplayIdentity {
    return {
      id: operation.id,
      ownerId: operation.ownerId,
      capsuleId: operation.capsuleId,
      type: operation.type,
      actor: {
        type: operation.actorType,
        id: operation.actorId,
      },
      idempotencyKey: operation.idempotencyKey,
      requestHash: operation.requestHash,
    }
  }

  private result(scope: ValidatedBranchOperation, newlyAccepted: boolean): BranchAcceptance<TOperation> {
    return {
      newlyAccepted,
      receipt: policy.receipt(this.locks.type, scope.operation, scope.extension, !newlyAccepted),
      operation: policy.transition(scope.operation),
      branch: policy.state(scope.branch),
    }
  }
}
