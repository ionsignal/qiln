import { and, eq, inArray } from 'drizzle-orm'
import {
  CapsuleBranchResourceCleanupPolicy,
  CapsuleBranchResourceStatus,
  CapsuleBranchResourceType,
  CapsuleOperationStatus,
  CapsuleOperationType,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from '../../../failures'
import { toJsonObject } from '../../../persistence/json'
import { createCapsuleCreateFailureContext } from '../execution/diagnostics'
import { CapsuleCreatePhase } from '../execution/phases'
import {
  classifyCapsuleCreateFailure,
  CapsuleCreateFailureDisposition,
  type CapsuleCreateFailureFacts,
} from '../policy/failure'
import { toCreateTerminalResult } from './result'
import type { CapsuleCreateResourceLineage } from '../resource/lineage'
import type { CapsuleCreateInventoryPolicy } from '../policy/inventory'
import type { CapsuleCreateFailureInput, CapsuleCreateTerminalResult } from '../types'
import type { CapsuleCreateLocks, CreateTransaction } from './locks'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

const NONTERMINAL_CREATE_STATUSES = [CapsuleOperationStatus.ACCEPTED, CapsuleOperationStatus.RUNNING] as const

type OperationRow<TTables extends CapsuleTables> = TTables['capsuleOperations']['$inferSelect']
type CapsuleRow<TTables extends CapsuleTables> = TTables['capsules']['$inferSelect']
type BranchRow<TTables extends CapsuleTables> = TTables['capsuleBranches']['$inferSelect']
type ResourceRow<TTables extends CapsuleTables> = TTables['capsuleBranchResources']['$inferSelect']

interface CapsuleCreateClassificationInput extends CapsuleCreateFailureInput {
  abandoned: boolean
}

function isNonterminal<TTables extends CapsuleTables>(status: OperationRow<TTables>['status']): boolean {
  return status === CapsuleOperationStatus.ACCEPTED || status === CapsuleOperationStatus.RUNNING
}

/**
 * Owns ordinary failure, compensated failure, cleanup-required state, and
 * provider-free abandonment classification.
 *
 * Compensation remains an executor responsibility. This boundary never
 * discovers resources, calls Incus, retries a mutation, or resumes an abandoned
 * operation.
 */
export class CapsuleCreateClassification<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly locks: CapsuleCreateLocks<TDatabase, TTables>,
    private readonly lineage: CapsuleCreateResourceLineage<TTables>,
    private readonly inventory: CapsuleCreateInventoryPolicy<TTables>,
  ) {}

  public async fail(input: CapsuleCreateFailureInput): Promise<CapsuleCreateTerminalResult> {
    return await this.persistence.db.transaction(async tx => {
      const operation = await this.locks.operation(tx, input.operationId)
      if (!isNonterminal<TTables>(operation.status)) {
        throw new IncusError('Capsule create operation is already terminal.', 'CONFLICT', {
          operationId: operation.id,
          operationStatus: operation.status,
        })
      }
      return await this.classify(tx, operation, {
        ...input,
        abandoned: false,
      })
    })
  }

  /**
   * Classifies a nonterminal create left by an earlier Worker using the same
   * locked durable proof as live failures.
   *
   * No same-process compensation evidence survives restart. Recorded provider
   * intent therefore prevents an ordinary failed outcome.
   */
  public async classifyAbandoned(operationId: string): Promise<CapsuleCreateTerminalResult | null> {
    return await this.persistence.db.transaction(async tx => {
      const operation = await this.locks.optionalOperation(tx, operationId)
      if (!operation || !isNonterminal<TTables>(operation.status)) {
        return null
      }
      return await this.classify(tx, operation, {
        operationId,
        error: new IncusError('Capsule create operation was abandoned by a previous Worker process.', 'API_ERROR', {
          operationId,
          providerMutationStartedAt: operation.providerMutationStartedAt,
          policy: 'no_provider_mutation_after_restart',
        }),
        phase: CapsuleCreatePhase.CLASSIFY_ABANDONED,
        providerIntentConfirmed: false,
        providerOwnershipUncertain: operation.providerMutationStartedAt !== null,
        completionAttempted: false,
        compensation: null,
        abandoned: true,
      })
    })
  }

  private async classify(
    tx: CreateTransaction<TDatabase>,
    operation: OperationRow<TTables>,
    input: CapsuleCreateClassificationInput,
  ): Promise<CapsuleCreateTerminalResult> {
    const extension = await this.locks.optionalExtension(tx, operation.id)
    const capsule = await this.locks.capsule(tx, operation.ownerId, operation.capsuleId)
    const branches = await this.locks.rootBranches(tx, operation.capsuleId, extension?.rootBranchId ?? null)
    const resources = await this.locks.resources(
      tx,
      operation.id,
      branches.map(branch => branch.id),
    )
    const inspection = this.lineage.inspect(operation, extension, branches)
    const rootBranch = inspection.valid
      ? inspection.lineage.rootBranch
      : this.selectRootBranch(operation, branches, extension?.rootBranchId ?? null)
    const contradictions = inspection.valid ? [] : [...inspection.contradictions]
    if (capsule.lifecycleStatus !== 'provisioning') {
      contradictions.push('capsule_not_provisioning')
    }
    if (capsule.archivedAt !== null) {
      contradictions.push('capsule_unexpectedly_archived')
    }
    if (rootBranch && rootBranch.status !== 'provisioning') {
      contradictions.push('root_branch_not_provisioning')
    }
    if (
      operation.completedAt !== null ||
      operation.failedAt !== null ||
      operation.failureCode !== null ||
      operation.failureMessage !== null ||
      operation.failureDetails !== null
    ) {
      contradictions.push('nonterminal_operation_contains_terminal_evidence')
    }
    if (
      (operation.status === CapsuleOperationStatus.ACCEPTED && operation.executionStartedAt !== null) ||
      (operation.status === CapsuleOperationStatus.RUNNING && operation.executionStartedAt === null)
    ) {
      contradictions.push('operation_execution_timestamp_mismatch')
    }
    const providerIntentRecorded = operation.providerMutationStartedAt !== null
    if (input.providerIntentConfirmed && !providerIntentRecorded) {
      contradictions.push('confirmed_provider_intent_missing_from_ledger')
    }
    if (providerIntentRecorded && operation.status !== CapsuleOperationStatus.RUNNING) {
      contradictions.push('provider_intent_without_running_operation')
    }
    const inventory = inspection.valid
      ? this.inventory.inspect(operation.id, inspection.lineage, resources)
      : {
          kind: 'inconsistent' as const,
          untouched: false,
          contradictions: ['resource_inventory_lineage_invalid'],
        }
    contradictions.push(...inventory.contradictions)
    if (providerIntentRecorded && inventory.kind !== 'complete') {
      contradictions.push('provider_intent_without_complete_inventory')
    }
    if (!providerIntentRecorded && inventory.kind === 'complete' && !inventory.untouched) {
      contradictions.push('resource_execution_evidence_before_provider_intent')
    }
    if (!providerIntentRecorded && input.compensation !== null) {
      contradictions.push('compensation_reported_without_provider_intent')
    }

    /**
     * A provisioning failure legitimately leaves a partial resource inventory.
     * Classification proves its recorded outcomes, not completion of the full
     * plan. Retained and external resources are not deletion obligations.
     */
    const compensationContradictions =
      providerIntentRecorded && rootBranch ? this.inspectCompensationLedger(operation, rootBranch, resources) : []
    const compensationProven =
      !input.abandoned &&
      input.compensation !== null &&
      input.compensation.fullyCompensated &&
      input.compensation.failures.length === 0 &&
      rootBranch !== null &&
      inventory.kind === 'complete' &&
      compensationContradictions.length === 0
    const facts: CapsuleCreateFailureFacts = {
      consistent: contradictions.length === 0,
      providerIntentRecorded,
      providerOwnershipUncertain: input.providerOwnershipUncertain,
      completionAttempted: input.completionAttempted || input.phase === CapsuleCreatePhase.COMPLETE_CREATE,
      inventory: inventory.kind === 'complete' ? (inventory.untouched ? 'untouched' : 'changed') : inventory.kind,
      compensationProven,
    }
    const disposition = classifyCapsuleCreateFailure(facts)
    const phase = input.abandoned
      ? CapsuleCreatePhase.CLASSIFY_ABANDONED
      : disposition === CapsuleCreateFailureDisposition.PRE_PROVIDER
        ? CapsuleCreatePhase.FAIL_BEFORE_PROVIDER_MUTATION
        : disposition === CapsuleCreateFailureDisposition.COMPENSATED
          ? CapsuleCreatePhase.FAIL_AFTER_SUCCESSFUL_COMPENSATION
          : CapsuleCreatePhase.MARK_CLEANUP_REQUIRED
    const context = createCapsuleCreateFailureContext({
      identity: {
        operationId: operation.id,
        capsuleId: operation.capsuleId,
        rootBranchId: rootBranch?.id ?? extension?.rootBranchId ?? null,
        rootBranchName: rootBranch?.name ?? extension?.rootBranchName ?? null,
      },
      phase,
      ...(input.abandoned ? {} : { failedPhase: input.phase }),
      disposition,
      facts,
      compensation: input.compensation,
      contradictions: [...contradictions, ...compensationContradictions],
    })
    return await this.persist(tx, {
      operation,
      capsule,
      rootBranch,
      disposition,
      error: input.error,
      context,
    })
  }

  /**
   * Ordinary compensated failure requires attribution and terminal cleanup
   * evidence from the locked ledger, not only the compensator's success flag.
   *
   * Planned resources have no recorded create intent. Creating, created,
   * deleting, and error states on direct resources cannot prove cleanup.
   */
  private inspectCompensationLedger(
    operation: OperationRow<TTables>,
    rootBranch: BranchRow<TTables>,
    resources: readonly ResourceRow<TTables>[],
  ): string[] {
    const contradictions: string[] = []
    for (const resource of resources) {
      if (
        resource.ownerId !== operation.ownerId ||
        resource.branchId !== rootBranch.id ||
        resource.branchName !== rootBranch.name ||
        resource.createdByOperationId !== operation.id ||
        resource.lastOperationId !== operation.id ||
        resource.provider !== 'incus'
      ) {
        contradictions.push(`resource_attribution_mismatch:${resource.id}`)
      }

      if (resource.failureCode !== null || resource.failureMessage !== null || resource.failureDetails !== null) {
        contradictions.push(`resource_failure_evidence_remaining:${resource.id}`)
      }
      switch (resource.resourceType) {
        case CapsuleBranchResourceType.INCUS_PROJECT:
          if (
            resource.cleanupPolicy !== CapsuleBranchResourceCleanupPolicy.RETAIN ||
            (resource.status !== CapsuleBranchResourceStatus.PLANNED &&
              resource.status !== CapsuleBranchResourceStatus.ADOPTED)
          ) {
            contradictions.push(`retained_project_outcome_unproven:${resource.id}`)
          }
          break
        case CapsuleBranchResourceType.BIND_MOUNT:
          if (
            resource.cleanupPolicy !== CapsuleBranchResourceCleanupPolicy.EXTERNAL ||
            (resource.status !== CapsuleBranchResourceStatus.PLANNED &&
              resource.status !== CapsuleBranchResourceStatus.ADOPTED)
          ) {
            contradictions.push(`external_mount_outcome_unproven:${resource.id}`)
          }
          break
        case CapsuleBranchResourceType.INCUS_INSTANCE:
        case CapsuleBranchResourceType.ZFS_VOLUME:
          if (
            resource.cleanupPolicy !== CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH ||
            (resource.status !== CapsuleBranchResourceStatus.PLANNED &&
              resource.status !== CapsuleBranchResourceStatus.DELETED &&
              resource.status !== CapsuleBranchResourceStatus.MISSING)
          ) {
            contradictions.push(`direct_resource_cleanup_unproven:${resource.id}`)
          }
          break
        case CapsuleBranchResourceType.PROVISIONING_FILE:
          if (
            resource.cleanupPolicy !== CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH ||
            (resource.status !== CapsuleBranchResourceStatus.PLANNED &&
              resource.status !== CapsuleBranchResourceStatus.DELETED)
          ) {
            contradictions.push(`derived_resource_cleanup_unproven:${resource.id}`)
          }
          break
      }
    }
    return contradictions
  }

  /**
   * Contradictory lineage must not authorize updates to another capsule's
   * branch. A uniquely identifiable local root can still be fenced for
   * cleanup.
   */
  private selectRootBranch(
    operation: OperationRow<TTables>,
    branches: readonly BranchRow<TTables>[],
    referencedBranchId: string | null,
  ): BranchRow<TTables> | null {
    const ownedRoots = branches.filter(
      branch => branch.ownerId === operation.ownerId && branch.capsuleId === operation.capsuleId && branch.isRootBranch,
    )
    const referenced = ownedRoots.find(branch => branch.id === referencedBranchId)
    return referenced ?? (ownedRoots.length === 1 ? ownedRoots[0]! : null)
  }

  /**
   * Persists exactly one selected classification. Database failures propagate;
   * they do not trigger another speculative terminalization attempt.
   */
  private async persist(
    tx: CreateTransaction<TDatabase>,
    input: {
      operation: OperationRow<TTables>
      capsule: CapsuleRow<TTables>
      rootBranch: BranchRow<TTables> | null
      disposition: CapsuleCreateFailureDisposition
      error: unknown
      context: Record<string, unknown>
    },
  ): Promise<CapsuleCreateTerminalResult> {
    const { operation, capsule, rootBranch, disposition, error, context } = input
    const cleanupRequired = disposition === CapsuleCreateFailureDisposition.CLEANUP_REQUIRED
    if (!cleanupRequired && rootBranch === null) {
      throw new IncusError('Ordinary capsule create failure requires a verified root branch.', 'CONFLICT', {
        operationId: operation.id,
      })
    }
    const { capsuleOperations, capsules, capsuleBranches } = this.persistence.tables
    const details = createFailureDetails(error, context)
    const now = new Date()
    const [classifiedOperation] = await tx
      .update(capsuleOperations)
      .set({
        status: cleanupRequired ? CapsuleOperationStatus.CLEANUP_REQUIRED : CapsuleOperationStatus.FAILED,
        failedAt: now,
        failureCode: failureCodeFromUnknown(error),
        failureMessage: failureMessageFromUnknown(
          error,
          cleanupRequired ? 'Capsule creation requires manual cleanup.' : 'Capsule creation failed.',
        ),
        failureDetails:
          details === undefined ? null : toJsonObject(details, 'capsule create failure classification details'),
        updatedAt: now,
      })
      .where(
        and(
          eq(capsuleOperations.id, operation.id),
          eq(capsuleOperations.type, CapsuleOperationType.CREATE),
          inArray(capsuleOperations.status, NONTERMINAL_CREATE_STATUSES),
        ),
      )
      .returning()
    const [classifiedCapsule] = await tx
      .update(capsules)
      .set({
        lifecycleStatus: cleanupRequired ? 'cleanup_required' : 'creation_failed',
        updatedAt: now,
      })
      .where(
        and(
          eq(capsules.id, capsule.id),
          eq(capsules.ownerId, operation.ownerId),
          eq(capsules.lifecycleStatus, capsule.lifecycleStatus),
        ),
      )
      .returning()
    let classifiedBranch: BranchRow<TTables> | null = rootBranch
    if (rootBranch && rootBranch.status !== 'destroyed') {
      // Preserve the durable root ID required by create receipt replay.
      const [updatedBranch] = await tx
        .update(capsuleBranches)
        .set({
          status: cleanupRequired ? 'cleanup_required' : 'destroyed',
          runtimeIp: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleBranches.id, rootBranch.id),
            eq(capsuleBranches.ownerId, operation.ownerId),
            eq(capsuleBranches.capsuleId, operation.capsuleId),
            eq(capsuleBranches.status, rootBranch.status),
            eq(capsuleBranches.isRootBranch, true),
          ),
        )
        .returning()
      if (!updatedBranch) {
        throw new IncusError('Failed to persist the classified capsule root branch.', 'CONFLICT', {
          operationId: operation.id,
          rootBranchId: rootBranch.id,
        })
      }
      classifiedBranch = updatedBranch
    }
    if (!classifiedOperation || !classifiedCapsule) {
      throw new IncusError('Failed to atomically classify capsule creation failure.', 'CONFLICT', {
        operationId: operation.id,
        disposition,
      })
    }
    return toCreateTerminalResult<TTables>(classifiedOperation, classifiedCapsule, classifiedBranch)
  }
}
