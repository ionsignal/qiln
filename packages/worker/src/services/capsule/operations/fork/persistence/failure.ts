import { and, asc, eq, inArray, ne } from 'drizzle-orm'
import {
  CapsuleBranchResourceCleanupPolicy,
  CapsuleBranchResourceStatus,
  CapsuleBranchResourceType,
  CapsuleOperationStatus,
  CapsuleOperationType,
  type CapsuleOperationStatusValue,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from '../../../failures'
import { toJsonObject } from '../../../persistence/json'
import { toCapsuleLifecycleState, toCapsuleOperationTransition, type CapsuleOperationReader } from '../../shared'
import { assertForkEvidence, ForkSourcePersistence } from './source'
import type { ForkPlanner } from '../plan'
import type { ForkAbandonmentResult, ForkBranch, ForkTerminal } from '../types'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

const NONTERMINAL = [CapsuleOperationStatus.ACCEPTED, CapsuleOperationStatus.RUNNING] as const
const DIRECT_TYPES = [CapsuleBranchResourceType.INCUS_INSTANCE, CapsuleBranchResourceType.ZFS_VOLUME] as const

type ForkOperation = CapsuleTables['capsuleOperations']['$inferSelect']
type ForkCapsule = CapsuleTables['capsules']['$inferSelect']
type ForkBranchRow = CapsuleTables['capsuleBranches']['$inferSelect']

function isNonterminal(status: CapsuleOperationStatusValue): status is (typeof NONTERMINAL)[number] {
  return status === CapsuleOperationStatus.ACCEPTED || status === CapsuleOperationStatus.RUNNING
}

/**
 * Owns safe pre-provider failure, compensated failure, cleanup-required
 * classification, and startup abandonment policy for forks.
 */
export class ForkFailurePersistence<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly reader: CapsuleOperationReader<TDatabase, TTables>,
    private readonly planner: ForkPlanner,
    private readonly sources: ForkSourcePersistence<TDatabase, TTables>,
  ) {}

  public async compensated(
    operationId: string,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<ForkTerminal> {
    return await this.persistence.db.transaction(async tx => {
      const operation = await this.lockOperation(tx, operationId)
      if (!isNonterminal(operation.status) || operation.providerMutationStartedAt === null) {
        throw new IncusError('Capsule fork is not eligible for compensated failure.', 'CONFLICT', {
          operationId,
          operationStatus: operation.status,
          providerIntentCommitted: operation.providerMutationStartedAt !== null,
        })
      }
      const extension = await this.lockExtension(tx, operation.id)
      const capsule = await this.lockCapsule(tx, operation.ownerId, operation.capsuleId)
      const branch = await this.lockBranch(tx, operation.ownerId, operation.capsuleId, extension.targetBranchId)
      const resources = await this.lockResources(tx, branch.id)
      for (const resource of resources) {
        if (resource.createdByOperationId !== operation.id || resource.lastOperationId !== operation.id) {
          throw new IncusError('Fork compensation resource lacks operation provenance.', 'CONFLICT', {
            operationId,
            resourceId: resource.id,
            createdByOperationId: resource.createdByOperationId,
            lastOperationId: resource.lastOperationId,
          })
        }
        if (
          DIRECT_TYPES.includes(resource.resourceType as (typeof DIRECT_TYPES)[number]) &&
          resource.cleanupPolicy === CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH
        ) {
          if (
            resource.status !== CapsuleBranchResourceStatus.PLANNED &&
            resource.status !== CapsuleBranchResourceStatus.DELETED &&
            resource.status !== CapsuleBranchResourceStatus.MISSING
          ) {
            throw new IncusError('Fork provider compensation is incomplete or uncertain.', 'CONFLICT', {
              operationId,
              resourceId: resource.id,
              resourceType: resource.resourceType,
              resourceStatus: resource.status,
            })
          }
          continue
        }
        if (resource.resourceType === CapsuleBranchResourceType.PROVISIONING_FILE) {
          if (
            resource.status !== CapsuleBranchResourceStatus.PLANNED &&
            resource.status !== CapsuleBranchResourceStatus.DELETED
          ) {
            throw new IncusError('Fork derived resource compensation is incomplete or uncertain.', 'CONFLICT', {
              operationId,
              resourceId: resource.id,
              resourceStatus: resource.status,
            })
          }
          continue
        }
        if (
          resource.resourceType === CapsuleBranchResourceType.INCUS_PROJECT ||
          resource.resourceType === CapsuleBranchResourceType.BIND_MOUNT
        ) {
          if (
            resource.status !== CapsuleBranchResourceStatus.PLANNED &&
            resource.status !== CapsuleBranchResourceStatus.ADOPTED
          ) {
            throw new IncusError('Fork adopted resource is in an uncertain state.', 'CONFLICT', {
              operationId,
              resourceId: resource.id,
              resourceType: resource.resourceType,
              resourceStatus: resource.status,
            })
          }
        }
      }
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
      const operation = await this.lockOperation(tx, operationId)
      if (!isNonterminal(operation.status)) {
        return null
      }
      const extension = await this.lockExtensionIfPresent(tx, operation.id)
      const capsule = await this.lockCapsule(tx, operation.ownerId, operation.capsuleId)
      const branch = extension
        ? await this.lockBranchIfPresent(tx, operation.ownerId, operation.capsuleId, extension.targetBranchId)
        : null
      const resources = branch ? await this.lockResources(tx, branch.id) : []
      const contradictions: string[] = []
      if (operation.providerMutationStartedAt !== null) {
        contradictions.push('provider_intent_present')
      }
      if (!extension) {
        contradictions.push('fork_extension_missing')
      }
      if (!branch) {
        contradictions.push('target_branch_missing')
      }
      if (capsule.lifecycleStatus !== 'active') {
        contradictions.push('capsule_not_active')
      }
      if (capsule.archivedAt !== null) {
        contradictions.push('capsule_archived')
      }
      if (branch && branch.status !== 'provisioning') {
        contradictions.push('target_branch_not_provisioning')
      }
      if (extension && branch) {
        try {
          const source = await this.sources.lock(tx, operation.ownerId, operation.capsuleId, extension.sourceSnapshotId)
          assertForkEvidence(operation, extension, source, branch)

          const plan = this.planner.create({
            operationId: operation.id,
            ownerId: operation.ownerId,
            branchId: branch.id,
            branchName: branch.name,
            cpu: extension.cpu,
            memory: extension.memory,
            source,
          })

          this.planner.assertResources({
            operationId: operation.id,
            ownerId: operation.ownerId,
            branchId: branch.id,
            branchName: branch.name,
            extensionInventoryDigest: extension.targetBranchResourceInventoryDigest,
            branchInventoryDigest: branch.resourceInventoryDigest,
            stage: 'accepted',
            plan,
            resources,
          })
        } catch (evidenceError: unknown) {
          contradictions.push('fork_evidence_invalid')
          context = {
            ...context,
            evidenceError:
              evidenceError instanceof Error
                ? {
                    name: evidenceError.name,
                    message: evidenceError.message,
                  }
                : {
                    value: evidenceError,
                  },
          }
        }
      }
      if (contradictions.length === 0 && branch) {
        return await this.fail(tx, operation, capsule, branch, error, {
          ...context,
          classification: 'safe_pre_provider_fork_failure',
          providerIntentCommitted: false,
        })
      }
      return await this.cleanup(tx, operation, capsule, branch, error, {
        ...context,
        classification: 'fork_cleanup_required',
        providerIntentCommitted: operation.providerMutationStartedAt !== null,
        extensionPresent: extension !== null,
        branchPresent: branch !== null,
        branchStatus: branch?.status ?? null,
        resourceCount: resources.length,
        contradictions,
      })
    })
  }

  public async abandon(operationId: string): Promise<ForkAbandonmentResult> {
    const operation = await this.reader.loadById(operationId)
    if (!operation || operation.type !== CapsuleOperationType.FORK || !isNonterminal(operation.status)) {
      return null
    }
    return await this.classify(
      operationId,
      new IncusError('Capsule fork was abandoned by a previous Worker process.', 'API_ERROR', {
        operationId,
        capsuleId: operation.capsuleId,
        providerMutationStartedAt: operation.providerMutationStartedAt,
      }),
      {
        phase: 'startup_abandoned_operation_classification',
        policy: 'never_resume_abandoned_fork_provider_mutations',
      },
    )
  }

  private async fail(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    operation: ForkOperation,
    capsule: ForkCapsule,
    branch: ForkBranchRow,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<ForkTerminal> {
    const tables = this.persistence.tables
    const details = createFailureDetails(error, context)
    const now = new Date()
    const [failed] = await tx
      .update(tables.capsuleOperations)
      .set({
        status: CapsuleOperationStatus.FAILED,
        failedAt: now,
        failureCode: failureCodeFromUnknown(error),
        failureMessage: failureMessageFromUnknown(error, 'Capsule fork failed.'),
        failureDetails: details === undefined ? undefined : toJsonObject(details, 'capsule fork failure details'),
        updatedAt: now,
      })
      .where(
        and(
          eq(tables.capsuleOperations.id, operation.id),
          eq(tables.capsuleOperations.type, CapsuleOperationType.FORK),
          inArray(tables.capsuleOperations.status, NONTERMINAL),
        ),
      )
      .returning({
        id: tables.capsuleOperations.id,
      })
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
          ne(tables.capsuleBranches.status, 'destroyed'),
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
    return this.terminal(operation, capsule, destroyed, CapsuleOperationStatus.FAILED)
  }

  private async cleanup(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    operation: ForkOperation,
    capsule: ForkCapsule,
    branch: ForkBranchRow | null,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<ForkTerminal> {
    const tables = this.persistence.tables
    const details = createFailureDetails(error, context)
    const now = new Date()
    const [cleanupOperation] = await tx
      .update(tables.capsuleOperations)
      .set({
        status: CapsuleOperationStatus.CLEANUP_REQUIRED,
        failedAt: now,
        failureCode: failureCodeFromUnknown(error),
        failureMessage: failureMessageFromUnknown(error, 'Capsule fork requires manual cleanup.'),
        failureDetails:
          details === undefined ? undefined : toJsonObject(details, 'capsule fork cleanup-required details'),
        updatedAt: now,
      })
      .where(
        and(
          eq(tables.capsuleOperations.id, operation.id),
          eq(tables.capsuleOperations.type, CapsuleOperationType.FORK),
          inArray(tables.capsuleOperations.status, NONTERMINAL),
        ),
      )
      .returning({
        id: tables.capsuleOperations.id,
      })
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
            ne(tables.capsules.lifecycleStatus, 'destroyed'),
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
    if (!branch) {
      throw new IncusError('Fork cleanup classification cannot resolve its target branch.', 'CONFLICT', {
        operationId: operation.id,
      })
    }
    let committedBranch: ForkBranch
    if (branch.status === 'destroyed') {
      committedBranch = {
        id: branch.id,
        capsuleId: branch.capsuleId,
        name: branch.name,
        status: branch.status,
      }
    } else {
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
            ne(tables.capsuleBranches.status, 'destroyed'),
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
    return this.terminal(operation, committedCapsule, committedBranch, CapsuleOperationStatus.CLEANUP_REQUIRED)
  }

  private terminal(
    operation: ForkOperation,
    capsule: ForkCapsule,
    branch: ForkBranch,
    status: 'failed' | 'cleanup_required',
  ): ForkTerminal {
    return {
      operation: toCapsuleOperationTransition({
        ownerId: operation.ownerId,
        operationId: operation.id,
        operationType: CapsuleOperationType.FORK,
        operationStatus: status,
        capsuleId: operation.capsuleId,
      }),
      capsule: toCapsuleLifecycleState({
        capsuleId: operation.capsuleId,
        lifecycleStatus: capsule.lifecycleStatus,
        archivedAt: capsule.archivedAt,
        destroyedAt: capsule.destroyedAt,
      }),
      branch,
    }
  }

  private async lockOperation(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    operationId: string,
  ): Promise<ForkOperation> {
    const operations = this.persistence.tables.capsuleOperations
    const [operation] = await tx
      .select()
      .from(operations)
      .where(and(eq(operations.id, operationId), eq(operations.type, CapsuleOperationType.FORK)))
      .for('update')
      .limit(1)
    if (!operation) {
      throw new IncusError('Capsule fork operation was not found.', 'NOT_FOUND', {
        operationId,
      })
    }
    return operation
  }

  private async lockExtension(tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0], operationId: string) {
    const extension = await this.lockExtensionIfPresent(tx, operationId)
    if (!extension) {
      throw new IncusError('Capsule fork operation extension was not found.', 'NOT_FOUND', {
        operationId,
      })
    }
    return extension
  }

  private async lockExtensionIfPresent(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    operationId: string,
  ) {
    const extensions = this.persistence.tables.capsuleForkOperations
    const [extension] = await tx
      .select()
      .from(extensions)
      .where(eq(extensions.operationId, operationId))
      .for('update')
      .limit(1)
    return extension ?? null
  }

  private async lockCapsule(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    ownerId: string,
    capsuleId: string,
  ): Promise<ForkCapsule> {
    const capsules = this.persistence.tables.capsules
    const [capsule] = await tx
      .select()
      .from(capsules)
      .where(and(eq(capsules.id, capsuleId), eq(capsules.ownerId, ownerId)))
      .for('update')
      .limit(1)
    if (!capsule) {
      throw new IncusError('Capsule not found or access denied.', 'NOT_FOUND', {
        ownerId,
        capsuleId,
      })
    }
    return capsule
  }

  private async lockBranch(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    ownerId: string,
    capsuleId: string,
    branchId: string,
  ): Promise<ForkBranchRow> {
    const branch = await this.lockBranchIfPresent(tx, ownerId, capsuleId, branchId)
    if (!branch) {
      throw new IncusError('Capsule fork target branch was not found.', 'NOT_FOUND', {
        ownerId,
        capsuleId,
        branchId,
      })
    }
    return branch
  }

  private async lockBranchIfPresent(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    ownerId: string,
    capsuleId: string,
    branchId: string,
  ): Promise<ForkBranchRow | null> {
    const branches = this.persistence.tables.capsuleBranches
    const [branch] = await tx
      .select()
      .from(branches)
      .where(and(eq(branches.id, branchId), eq(branches.ownerId, ownerId), eq(branches.capsuleId, capsuleId)))
      .for('update')
      .limit(1)
    return branch ?? null
  }

  private async lockResources(tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0], branchId: string) {
    const resources = this.persistence.tables.capsuleBranchResources
    return await tx
      .select()
      .from(resources)
      .where(eq(resources.branchId, branchId))
      .orderBy(asc(resources.createdAt), asc(resources.id))
      .for('update')
  }
}
