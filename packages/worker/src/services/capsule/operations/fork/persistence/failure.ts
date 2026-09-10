import { and, eq, inArray } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  GlobalError,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import { ZodError } from 'zod'
import { IncusError } from '../../../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from '../../../failures'
import { toJsonObject } from '../../../persistence/json'
import { toCapsuleLifecycleState, toCapsuleOperationTransition } from '../../shared'
import { assertForkIdentity, assertForkLedger } from './source'
import type { ForkAbandonmentResult, ForkBranch, ForkTerminal } from '../types'
import type { ForkInputPersistence } from './input'
import type { ForkLocks, ForkScope, ForkTransaction } from './locks'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

const NONTERMINAL = [CapsuleOperationStatus.ACCEPTED, CapsuleOperationStatus.RUNNING] as const

type ForkOperation = CapsuleTables['capsuleOperations']['$inferSelect']
type ForkCapsule = CapsuleTables['capsules']['$inferSelect']
type ForkBranchRow = CapsuleTables['capsuleBranches']['$inferSelect']

function isNonterminal(status: ForkOperation['status']): boolean {
  return status === CapsuleOperationStatus.ACCEPTED || status === CapsuleOperationStatus.RUNNING
}

function isEvidenceError(error: unknown): boolean {
  return error instanceof IncusError || error instanceof GlobalError || error instanceof ZodError
}

/**
 * Owns safe pre-provider failure, compensated failure, cleanup-required
 * classification, and startup abandonment policy for forks.
 *
 * Missing target identity can produce a committed cleanup classification with
 * no branch result. It never authorizes a guessed branch update.
 */
export class ForkFailurePersistence<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly locks: ForkLocks<TDatabase, TTables>,
    private readonly input: ForkInputPersistence<TDatabase, TTables>,
  ) {}

  public async compensated(
    operationId: string,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<ForkTerminal> {
    return await this.persistence.db.transaction(async tx => {
      const scope = await this.locks.scope(tx, operationId)
      const { operation, capsule, branch } = scope
      if (
        operation.status !== CapsuleOperationStatus.RUNNING ||
        operation.providerMutationStartedAt === null ||
        context.finalizationAttempted === true ||
        context.providerOwnershipUncertain === true ||
        !branch
      ) {
        throw new IncusError('Capsule fork is not eligible for compensated failure.', 'CONFLICT', {
          operationId,
          operationStatus: operation.status,
          providerIntentCommitted: operation.providerMutationStartedAt !== null,
        })
      }

      // Complete plan coverage, cleanup policies, attribution, and pristine
      // terminal outcomes are required; an empty or partial ledger cannot pass.
      await this.input.prove(tx, scope, 'compensated')

      return await this.fail(tx, operation, capsule, branch, error, {
        ...context,
        classification: 'fork_failure_after_complete_compensation',
        providerIntentCommitted: true,
        compensationComplete: true,
      })
    })
  }

  public async classify(
    operationId: string,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<ForkTerminal | null> {
    return await this.persistence.db.transaction(async tx => {
      const scope = await this.locks.scope(tx, operationId)
      const { operation, capsule } = scope
      if (!isNonterminal(operation.status)) {
        return null
      }
      const contradictions: string[] = []
      if (operation.providerMutationStartedAt !== null) {
        contradictions.push('provider_intent_present')
      }
      if (context.providerIntentObserved === true && operation.providerMutationStartedAt === null) {
        contradictions.push('observed_provider_intent_missing_from_ledger')
      }
      if (context.finalizationAttempted === true) {
        contradictions.push('finalization_uncertain')
      }
      if (context.providerOwnershipUncertain === true) {
        contradictions.push('provider_ownership_uncertain')
      }
      let evidenceError: unknown
      try {
        assertForkLedger(operation)
        await this.input.prove(tx, scope, 'accepted')
      } catch (error: unknown) {
        if (!isEvidenceError(error)) {
          throw error
        }
        contradictions.push('fork_evidence_invalid')
        evidenceError = error
      }
      if (contradictions.length === 0 && scope.branch) {
        return await this.fail(tx, operation, capsule, scope.branch, error, {
          ...context,
          classification: 'safe_pre_provider_fork_failure',
          providerIntentCommitted: false,
        })
      }
      const branch = this.target(scope)
      return await this.cleanup(tx, operation, capsule, branch, error, {
        ...context,
        classification: 'fork_cleanup_required',
        providerIntentCommitted: operation.providerMutationStartedAt !== null,
        extensionPresent: scope.extension !== null,
        branchPresent: scope.branch !== null,
        targetIdentityProven: branch !== null,
        branchStatus: branch?.status ?? null,
        contradictions,
        evidenceError:
          evidenceError instanceof Error
            ? {
                name: evidenceError.name,
                message: evidenceError.message,
              }
            : null,
      })
    })
  }

  public async abandon(operationId: string): Promise<ForkAbandonmentResult> {
    return await this.classify(
      operationId,
      new IncusError('Capsule fork was abandoned by a previous Worker process.', 'API_ERROR', {
        operationId,
      }),
      {
        phase: 'startup_abandoned_operation_classification',
        policy: 'never_resume_abandoned_fork_provider_mutations',
      },
    )
  }

  private target(scope: ForkScope): ForkBranchRow | null {
    if (!scope.extension || !scope.branch) {
      return null
    }
    try {
      assertForkIdentity(scope.operation, scope.extension, scope.branch)
      return scope.branch
    } catch (error: unknown) {
      if (!isEvidenceError(error)) {
        throw error
      }
      return null
    }
  }

  private async fail(
    tx: ForkTransaction<TDatabase>,
    operation: ForkOperation,
    capsule: ForkCapsule,
    branch: ForkBranchRow,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<ForkTerminal> {
    const tables = this.persistence.tables
    const details = createFailureDetails(error, context) ?? {}
    const now = new Date()
    const [failed] = await tx
      .update(tables.capsuleOperations)
      .set({
        status: CapsuleOperationStatus.FAILED,
        failedAt: now,
        failureCode: failureCodeFromUnknown(error),
        failureMessage: failureMessageFromUnknown(error, 'Capsule fork failed.'),
        failureDetails: toJsonObject(details, 'capsule fork failure details'),
        updatedAt: now,
      })
      .where(
        and(
          eq(tables.capsuleOperations.id, operation.id),
          eq(tables.capsuleOperations.type, CapsuleOperationType.FORK),
          inArray(tables.capsuleOperations.status, NONTERMINAL),
        ),
      )
      .returning()
    const [destroyed] = await tx
      .update(tables.capsuleBranches)
      .set({
        status: 'destroyed',
        runtimeIp: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(tables.capsuleBranches.id, branch.id),
          eq(tables.capsuleBranches.ownerId, operation.ownerId),
          eq(tables.capsuleBranches.capsuleId, operation.capsuleId),
          eq(tables.capsuleBranches.isRootBranch, false),
          eq(tables.capsuleBranches.status, 'provisioning'),
        ),
      )
      .returning({
        id: tables.capsuleBranches.id,
        capsuleId: tables.capsuleBranches.capsuleId,
        name: tables.capsuleBranches.name,
        status: tables.capsuleBranches.status,
      })
    if (!failed || !destroyed) {
      throw new IncusError('Failed to atomically terminalize the capsule fork failure.', 'CONFLICT', {
        operationId: operation.id,
        branchId: branch.id,
      })
    }
    return this.terminal(failed, capsule, destroyed)
  }

  private async cleanup(
    tx: ForkTransaction<TDatabase>,
    operation: ForkOperation,
    capsule: ForkCapsule,
    branch: ForkBranchRow | null,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<ForkTerminal> {
    const tables = this.persistence.tables
    const details = createFailureDetails(error, context) ?? {}
    const now = new Date()
    const [cleanupOperation] = await tx
      .update(tables.capsuleOperations)
      .set({
        status: CapsuleOperationStatus.CLEANUP_REQUIRED,
        failedAt: now,
        failureCode: failureCodeFromUnknown(error),
        failureMessage: failureMessageFromUnknown(error, 'Capsule fork requires manual cleanup.'),
        failureDetails: toJsonObject(details, 'capsule fork cleanup-required details'),
        updatedAt: now,
      })
      .where(
        and(
          eq(tables.capsuleOperations.id, operation.id),
          eq(tables.capsuleOperations.type, CapsuleOperationType.FORK),
          inArray(tables.capsuleOperations.status, NONTERMINAL),
        ),
      )
      .returning()
    if (!cleanupOperation) {
      throw new IncusError('Failed to classify the capsule fork cleanup-required.', 'CONFLICT', {
        operationId: operation.id,
      })
    }
    let committedCapsule = capsule
    if (capsule.lifecycleStatus !== 'destroyed') {
      const [cleanupCapsule] = await tx
        .update(tables.capsules)
        .set({
          lifecycleStatus: 'cleanup_required',
          updatedAt: now,
        })
        .where(
          and(
            eq(tables.capsules.id, operation.capsuleId),
            eq(tables.capsules.ownerId, operation.ownerId),
            eq(tables.capsules.lifecycleStatus, capsule.lifecycleStatus),
          ),
        )
        .returning()
      if (!cleanupCapsule) {
        throw new IncusError('Failed to mark the capsule cleanup-required after fork uncertainty.', 'CONFLICT', {
          operationId: operation.id,
          capsuleId: operation.capsuleId,
        })
      }
      committedCapsule = cleanupCapsule
    }
    let committedBranch: ForkBranch | null = null
    if (branch?.status === 'destroyed') {
      committedBranch = {
        id: branch.id,
        capsuleId: branch.capsuleId,
        name: branch.name,
        status: branch.status,
      }
    } else if (branch) {
      const [cleanupBranch] = await tx
        .update(tables.capsuleBranches)
        .set({
          status: 'cleanup_required',
          runtimeIp: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(tables.capsuleBranches.id, branch.id),
            eq(tables.capsuleBranches.ownerId, operation.ownerId),
            eq(tables.capsuleBranches.capsuleId, operation.capsuleId),
            eq(tables.capsuleBranches.isRootBranch, false),
            eq(tables.capsuleBranches.status, branch.status),
          ),
        )
        .returning({
          id: tables.capsuleBranches.id,
          capsuleId: tables.capsuleBranches.capsuleId,
          name: tables.capsuleBranches.name,
          status: tables.capsuleBranches.status,
        })
      if (!cleanupBranch) {
        throw new IncusError('Failed to mark the fork branch cleanup-required.', 'CONFLICT', {
          operationId: operation.id,
          branchId: branch.id,
        })
      }
      committedBranch = cleanupBranch
    }
    return this.terminal(cleanupOperation, committedCapsule, committedBranch)
  }

  private terminal(operation: ForkOperation, capsule: ForkCapsule, branch: ForkBranch | null): ForkTerminal {
    return {
      operation: toCapsuleOperationTransition({
        ownerId: operation.ownerId,
        operationId: operation.id,
        operationType: CapsuleOperationType.FORK,
        operationStatus: operation.status,
        capsuleId: operation.capsuleId,
      }),
      capsule: toCapsuleLifecycleState({
        capsuleId: capsule.id,
        lifecycleStatus: capsule.lifecycleStatus,
        archivedAt: capsule.archivedAt,
        destroyedAt: capsule.destroyedAt,
      }),
      branch,
    }
  }
}
