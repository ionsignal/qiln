import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import {
  CapsuleOperationType,
  CapsuleSnapshotCreateReceiptSchema,
  GlobalError,
  verifyCapsuleBlueprintPin,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import { ZodError } from 'zod'
import { IncusError, isUniqueConstraintViolation } from '../../../../../errors'
import { CapsuleBranchProvenance } from '../../../branch/provenance'
import { createFailureDetails, failureCodeFromUnknown } from '../../../failures'
import { toJsonObject } from '../../../persistence/json'
import { CapsuleSnapshotStore } from '../../../snapshot/store'
import {
  assertOperationReplayIdentity,
  readRootfs,
  sameRootfs,
  toCapsuleLifecycleState,
  toCapsuleOperationTransition,
} from '../../shared'
import { SnapshotPlanner } from '../plan'
import type { PreviewGate } from '../../../routing/preview/gate'
import type {
  SnapshotAcceptance,
  SnapshotAcceptanceInput,
  SnapshotBranch,
  SnapshotCommit,
  SnapshotExecution,
  SnapshotFailureInput,
  SnapshotResource,
  SnapshotTransition,
} from '../types'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

type Transaction<TDatabase extends PostgresJsDatabase> = Parameters<Parameters<TDatabase['transaction']>[0]>[0]
type Operation = CapsuleTables['capsuleOperations']['$inferSelect']
type Capsule = CapsuleTables['capsules']['$inferSelect']
type Branch = CapsuleTables['capsuleBranches']['$inferSelect']
type Extension = CapsuleTables['capsuleSnapshotCreateOperations']['$inferSelect']

interface LockedSnapshot {
  operation: Operation
  capsule: Capsule
  extension: Extension | null
  branch: Branch | null
}

interface ProvenSnapshot extends LockedSnapshot {
  extension: Extension
  branch: Branch
  execution: SnapshotExecution
  resources: SnapshotResource[]
}

const NONTERMINAL = ['accepted', 'running'] as const

function isNonterminal(status: Operation['status']): boolean {
  return status === 'accepted' || status === 'running'
}

function pristine(resource: SnapshotResource): boolean {
  return resource.failureCode === null && resource.failureMessage === null && resource.failureDetails === null
}

/**
 * Owns Create Snapshot transactions and immutable execution input.
 *
 * Capsule locks precede branch and operation locks. Provider work never runs
 * inside these transactions. Snapshot rows are inserted only by atomic commit.
 */
export class SnapshotRepository<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  private readonly provenance: CapsuleBranchProvenance<TDatabase, TTables>
  private readonly planner = new SnapshotPlanner()
  private readonly snapshots: CapsuleSnapshotStore<TDatabase, TTables>

  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly previews: PreviewGate<TDatabase, TTables>,
  ) {
    this.provenance = new CapsuleBranchProvenance(persistence)
    this.snapshots = new CapsuleSnapshotStore(persistence)
  }

  public async accept(input: SnapshotAcceptanceInput): Promise<SnapshotAcceptance> {
    try {
      return await this.persistence.db.transaction(async tx => {
        const capsule = await this.lockCapsule(tx, input.ownerId, input.capsuleId)
        const replay = await this.replay(tx, input, capsule)
        if (replay) {
          return replay
        }
        if (capsule.lifecycleStatus !== 'active' || capsule.archivedAt !== null || capsule.destroyedAt !== null) {
          throw new IncusError('Create Snapshot requires an active, unarchived capsule.', 'CONFLICT')
        }
        const branch = await this.lockBranch(tx, input.ownerId, input.capsuleId, input.sourceBranchId)
        if (!branch || branch.status !== 'offline' || branch.runtimeIp !== null) {
          throw new IncusError('Create Snapshot requires an offline editable branch.', 'CONFLICT')
        }
        await this.previews.assertBranchWithdrawn(tx, input.ownerId, input.capsuleId, branch.id)
        const pins = await this.provenance.lock(tx, branch)
        const inventory = await this.inventory(tx, branch.id)
        const tables = this.persistence.tables
        const now = new Date()
        const [operation] = await tx
          .insert(tables.capsuleOperations)
          .values({
            ownerId: input.ownerId,
            actorType: input.actor.type,
            actorId: input.actor.id,
            capsuleId: input.capsuleId,
            type: CapsuleOperationType.SNAPSHOT_CREATE,
            status: 'accepted',
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            acceptedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
        if (!operation) {
          throw new IncusError('Failed to accept Create Snapshot.', 'API_ERROR')
        }
        const plan = this.planner.create({
          operationId: operation.id,
          branch,
          provenance: pins,
          resources: inventory,
        })
        await tx.insert(tables.capsuleSnapshotCreateOperations).values({
          operationId: operation.id,
          sourceBranchId: branch.id,
          sourceBranchName: branch.name,
          sourceBranchResourceInventoryDigest: plan.inventoryDigest,
          blueprintSchemaVersion: pins.blueprint.blueprint.schema_version,
          blueprintName: pins.blueprint.name,
          blueprintDigest: pins.blueprint.digest,
          blueprintPin: pins.blueprint,
          rootfsImagePin: pins.rootfsImagePin,
          snapshotId: null,
        })
        if (plan.volumes.length > 0) {
          const inserted = await tx
            .insert(tables.capsuleSnapshotCreateResources)
            .values(
              plan.volumes.map(volume => ({
                ...volume,
                operationId: operation.id,
                status: 'planned' as const,
                createdAt: now,
                updatedAt: now,
              })),
            )
            .returning({
              id: tables.capsuleSnapshotCreateResources.id,
            })
          if (inserted.length !== plan.volumes.length) {
            throw new IncusError('Failed to accept complete snapshot resource accounting.', 'API_ERROR')
          }
        }
        const [fenced] = await tx
          .update(tables.capsuleBranches)
          .set({
            status: 'snapshotting',
            runtimeIp: null,
            runtimeErrorCode: null,
            runtimeErrorMessage: null,
            runtimeErrorDetails: null,
            runtimeErrorAt: null,
            updatedAt: now,
          })
          .where(and(eq(tables.capsuleBranches.id, branch.id), eq(tables.capsuleBranches.status, 'offline')))
          .returning()
        if (!fenced) {
          throw new IncusError('Failed to fence the snapshot source branch.', 'CONFLICT')
        }
        return {
          newlyAccepted: true,
          receipt: this.receipt(operation, branch.id, branch.name, false),
          ...this.transition(operation, capsule, [fenced]),
        }
      })
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) {
        throw error
      }
      const replay = await this.persistence.db.transaction(async tx => {
        const capsule = await this.lockCapsule(tx, input.ownerId, input.capsuleId)
        return await this.replay(tx, input, capsule)
      })
      if (replay) {
        return replay
      }
      throw new IncusError('Create Snapshot conflicts with another durable capsule operation.', 'CONFLICT', {
        capsuleId: input.capsuleId,
        sourceBranchId: input.sourceBranchId,
      })
    }
  }

  public async claim(operationId: string): Promise<{
    execution: SnapshotExecution
    transition: SnapshotTransition
  }> {
    return await this.persistence.db.transaction(async tx => {
      const scope = await this.prove(tx, await this.lock(tx, operationId))
      if (
        scope.operation.status !== 'accepted' ||
        scope.operation.executionStartedAt !== null ||
        scope.operation.providerMutationStartedAt !== null ||
        scope.resources.some(resource => resource.status !== 'planned' || !pristine(resource))
      ) {
        throw new IncusError('Create Snapshot cannot be claimed from its current state.', 'CONFLICT', {
          operationId,
        })
      }
      const operations = this.persistence.tables.capsuleOperations
      const now = new Date()
      const [running] = await tx
        .update(operations)
        .set({
          status: 'running',
          executionStartedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(operations.id, operationId),
            eq(operations.type, CapsuleOperationType.SNAPSHOT_CREATE),
            eq(operations.status, 'accepted'),
            isNull(operations.executionStartedAt),
            isNull(operations.providerMutationStartedAt),
          ),
        )
        .returning()
      if (!running) {
        throw new IncusError('Failed to claim Create Snapshot.', 'CONFLICT', {
          operationId,
        })
      }
      return {
        execution: scope.execution,
        transition: this.transition(running, scope.capsule, []),
      }
    })
  }

  /**
   * Commits the base provider fence and resource creation intent together.
   *
   * A provider request is permitted only after this transaction returns.
   */
  public async creating(operationId: string, volumeName: string): Promise<SnapshotResource> {
    return await this.persistence.db.transaction(async tx => {
      const scope = await this.prove(tx, await this.lock(tx, operationId))
      this.assertRunning(scope.operation)
      const resource = scope.resources.find(candidate => candidate.blueprintVolumeName === volumeName)
      if (!resource || resource.status !== 'planned' || !pristine(resource)) {
        throw new IncusError('Snapshot resource is not in its accepted pre-provider state.', 'CONFLICT', {
          operationId,
          volumeName,
        })
      }
      if (
        scope.resources.some(candidate => !['planned', 'created'].includes(candidate.status) || !pristine(candidate))
      ) {
        throw new IncusError('Snapshot creation is blocked by unresolved provider accounting.', 'CONFLICT', {
          operationId,
        })
      }
      const tables = this.persistence.tables
      const now = new Date()
      if (scope.operation.providerMutationStartedAt === null) {
        const [fenced] = await tx
          .update(tables.capsuleOperations)
          .set({
            providerMutationStartedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(tables.capsuleOperations.id, operationId),
              eq(tables.capsuleOperations.type, CapsuleOperationType.SNAPSHOT_CREATE),
              eq(tables.capsuleOperations.status, 'running'),
              isNull(tables.capsuleOperations.providerMutationStartedAt),
            ),
          )
          .returning({
            id: tables.capsuleOperations.id,
          })
        if (!fenced) {
          throw new IncusError('Failed to persist snapshot provider intent.', 'CONFLICT', {
            operationId,
          })
        }
      }
      const [creating] = await tx
        .update(tables.capsuleSnapshotCreateResources)
        .set({
          status: 'creating',
          updatedAt: now,
        })
        .where(
          and(
            eq(tables.capsuleSnapshotCreateResources.id, resource.id),
            eq(tables.capsuleSnapshotCreateResources.status, 'planned'),
          ),
        )
        .returning()
      if (!creating) {
        throw new IncusError('Failed to persist snapshot resource intent.', 'CONFLICT', {
          operationId,
          resourceId: resource.id,
        })
      }
      return creating
    })
  }

  public async created(operationId: string, resourceId: string): Promise<SnapshotResource> {
    return await this.resourceTransition(operationId, resourceId, 'creating', 'created')
  }

  public async deleting(operationId: string, resourceId: string): Promise<SnapshotResource> {
    return await this.resourceTransition(operationId, resourceId, 'created', 'deleting')
  }

  public async deleted(
    operationId: string,
    resourceId: string,
    status: 'deleted' | 'missing',
  ): Promise<SnapshotResource> {
    return await this.resourceTransition(operationId, resourceId, 'deleting', status)
  }

  public async resourceError(operationId: string, resourceId: string, error: unknown): Promise<void> {
    await this.persistence.db.transaction(async tx => {
      const scope = await this.prove(tx, await this.lock(tx, operationId))
      this.assertRunning(scope.operation)
      const resource = scope.resources.find(candidate => candidate.id === resourceId)
      if (
        scope.operation.providerMutationStartedAt === null ||
        !resource ||
        (resource.status !== 'creating' && resource.status !== 'deleting')
      ) {
        throw new IncusError('Snapshot resource cannot record a provider failure from its current state.', 'CONFLICT', {
          operationId,
          resourceId,
        })
      }
      const resources = this.persistence.tables.capsuleSnapshotCreateResources
      const details =
        createFailureDetails(error, {
          operationId,
          resourceId,
        }) ?? {}
      const [updated] = await tx
        .update(resources)
        .set({
          status: 'error',
          failureCode: failureCodeFromUnknown(error),
          failureMessage: 'Snapshot provider outcome is uncertain.',
          failureDetails: toJsonObject(details, 'snapshot resource failure'),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(resources.id, resourceId),
            eq(resources.operationId, operationId),
            eq(resources.status, resource.status),
          ),
        )
        .returning({
          id: resources.id,
        })
      if (!updated) {
        throw new IncusError('Failed to persist snapshot resource failure.', 'CONFLICT', {
          operationId,
          resourceId,
        })
      }
    })
  }

  public async resources(operationId: string): Promise<SnapshotResource[]> {
    return await this.persistence.db.transaction(async tx => {
      const scope = await this.prove(tx, await this.lock(tx, operationId))
      this.assertRunning(scope.operation)
      return scope.resources
    })
  }

  public async commit(operationId: string): Promise<SnapshotCommit> {
    return await this.persistence.db.transaction(async tx => {
      const scope = await this.prove(tx, await this.lock(tx, operationId))
      this.assertRunning(scope.operation)
      if (
        scope.resources.some(resource => resource.status !== 'created' || !pristine(resource)) ||
        (scope.resources.length > 0 && scope.operation.providerMutationStartedAt === null) ||
        (scope.resources.length === 0 && scope.operation.providerMutationStartedAt !== null)
      ) {
        throw new IncusError('Snapshot does not have complete successful provider evidence.', 'CONFLICT', {
          operationId,
        })
      }
      const tables = this.persistence.tables
      const extension = scope.extension
      const now = new Date()
      const [snapshot] = await tx
        .insert(tables.capsuleSnapshots)
        .values({
          capsuleId: scope.operation.capsuleId,
          sourceBranchId: extension.sourceBranchId,
          sourceBranchName: extension.sourceBranchName,
          sourceBranchResourceInventoryDigest: extension.sourceBranchResourceInventoryDigest,
          blueprintSchemaVersion: extension.blueprintSchemaVersion,
          blueprintName: extension.blueprintName,
          blueprintDigest: extension.blueprintDigest,
          blueprintPin: scope.execution.blueprint,
          rootfsImagePin: scope.execution.rootfsImagePin,
          createdAt: now,
        })
        .returning({
          id: tables.capsuleSnapshots.id,
        })
      if (!snapshot) {
        throw new IncusError('Failed to insert committed snapshot restoration evidence.', 'API_ERROR', {
          operationId,
        })
      }
      if (scope.resources.length > 0) {
        const references = await tx
          .insert(tables.capsuleSnapshotResourceReferences)
          .values(
            scope.resources.map(resource => ({
              snapshotId: snapshot.id,
              sourceBranchResourceId: resource.sourceBranchResourceId,
              createResourceId: resource.id,
              provider: resource.provider,
              kind: resource.kind,
              blueprintVolumeName: resource.blueprintVolumeName,
              project: resource.project,
              pool: resource.pool,
              sourceVolume: resource.sourceVolume,
              snapshotName: resource.snapshotName,
            })),
          )
          .returning({
            id: tables.capsuleSnapshotResourceReferences.id,
          })
        if (references.length !== scope.resources.length) {
          throw new IncusError('Failed to commit complete managed-volume snapshot references.', 'API_ERROR', {
            operationId,
          })
        }
      }
      const [linked] = await tx
        .update(tables.capsuleSnapshotCreateOperations)
        .set({
          snapshotId: snapshot.id,
        })
        .where(
          and(
            eq(tables.capsuleSnapshotCreateOperations.operationId, operationId),
            isNull(tables.capsuleSnapshotCreateOperations.snapshotId),
          ),
        )
        .returning({
          operationId: tables.capsuleSnapshotCreateOperations.operationId,
        })
      const [completed] = await tx
        .update(tables.capsuleOperations)
        .set({
          status: 'completed',
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(tables.capsuleOperations.id, operationId),
            eq(tables.capsuleOperations.type, CapsuleOperationType.SNAPSHOT_CREATE),
            eq(tables.capsuleOperations.status, 'running'),
          ),
        )
        .returning()
      const branch = await this.restoreBranch(tx, scope.branch, now)
      if (!linked || !completed) {
        throw new IncusError('Failed to atomically complete Create Snapshot.', 'CONFLICT', {
          operationId,
        })
      }
      return {
        snapshotId: snapshot.id,
        ...this.transition(completed, scope.capsule, [branch]),
      }
    })
  }

  /**
   * Restores accepted offline state only when the ledger remains consistent,
   * provider accounting is safe, and no live runtime uncertainty contradicts
   * it.
   *
   * Compensation proves snapshot removal, not source runtime state. Abandonment
   * can use untouched accounting only and never authorizes compensation.
   */
  public async fail(input: SnapshotFailureInput): Promise<SnapshotTransition | null> {
    const { operationId, error } = input
    return await this.persistence.db.transaction(async tx => {
      const locked = await this.lock(tx, operationId)
      if (!isNonterminal(locked.operation.status)) {
        return null
      }
      let proven: ProvenSnapshot | null = null
      let evidenceError: unknown
      try {
        proven = await this.prove(tx, locked)
      } catch (validationError: unknown) {
        if (
          !(validationError instanceof IncusError) &&
          !(validationError instanceof GlobalError) &&
          !(validationError instanceof ZodError)
        ) {
          throw validationError
        }
        evidenceError = validationError
      }
      const untouched =
        proven !== null &&
        proven.operation.providerMutationStartedAt === null &&
        proven.resources.every(resource => resource.status === 'planned' && pristine(resource))
      const compensated =
        input.origin === 'live' &&
        input.compensated &&
        proven !== null &&
        proven.operation.providerMutationStartedAt !== null &&
        proven.resources.some(resource => resource.status === 'deleted' || resource.status === 'missing') &&
        proven.resources.every(
          resource =>
            (resource.status === 'planned' || resource.status === 'deleted' || resource.status === 'missing') &&
            pristine(resource),
        )
      const runtimeSafe =
        input.origin === 'abandoned'
          ? untouched
          : input.runtime === 'offline' || (input.runtime === 'unobserved' && untouched)
      const finalizationUncertain = input.origin === 'live' && input.finalizationAttempted
      const safe = (untouched || compensated) && runtimeSafe && !finalizationUncertain
      const tables = this.persistence.tables
      const now = new Date()
      const details =
        createFailureDetails(error, {
          operationId,
          origin: input.origin,
          runtimeEvidence: input.origin === 'live' ? input.runtime : 'unobserved',
          runtimeSafe,
          finalizationUncertain,
          compensationReported: input.origin === 'live' && input.compensated,
          compensationProven: compensated,
          classification: safe
            ? untouched
              ? 'pre_provider_snapshot_failure'
              : 'compensated_snapshot_failure'
            : 'snapshot_cleanup_required',
          evidenceError:
            evidenceError instanceof Error
              ? {
                  name: evidenceError.name,
                  message: evidenceError.message,
                }
              : null,
        }) ?? {}
      const [operation] = await tx
        .update(tables.capsuleOperations)
        .set({
          status: safe ? 'failed' : 'cleanup_required',
          failedAt: now,
          failureCode: failureCodeFromUnknown(error),
          failureMessage: safe ? 'Create Snapshot failed.' : 'Create Snapshot requires manual cleanup and inspection.',
          failureDetails: toJsonObject(details, 'Create Snapshot failure'),
          updatedAt: now,
        })
        .where(
          and(
            eq(tables.capsuleOperations.id, operationId),
            eq(tables.capsuleOperations.type, CapsuleOperationType.SNAPSHOT_CREATE),
            inArray(tables.capsuleOperations.status, NONTERMINAL),
          ),
        )
        .returning()
      if (!operation) {
        throw new IncusError('Failed to classify Create Snapshot.', 'CONFLICT', {
          operationId,
        })
      }
      if (safe && proven) {
        const branch = await this.restoreBranch(tx, proven.branch, now)
        return this.transition(operation, locked.capsule, [branch])
      }
      let capsule = locked.capsule
      if (capsule.lifecycleStatus !== 'destroyed') {
        const [updated] = await tx
          .update(tables.capsules)
          .set({
            lifecycleStatus: 'cleanup_required',
            updatedAt: now,
          })
          .where(
            and(
              eq(tables.capsules.id, capsule.id),
              eq(tables.capsules.ownerId, operation.ownerId),
              eq(tables.capsules.lifecycleStatus, capsule.lifecycleStatus),
            ),
          )
          .returning()
        if (!updated) {
          throw new IncusError('Failed to fence the capsule after snapshot uncertainty.', 'CONFLICT')
        }
        capsule = updated
      }
      const branches: SnapshotBranch[] = []
      const source = locked.branch
      if (
        source &&
        locked.extension?.operationId === operation.id &&
        locked.extension.sourceBranchId === source.id &&
        source.ownerId === operation.ownerId &&
        source.capsuleId === operation.capsuleId &&
        source.status === 'snapshotting'
      ) {
        const [branch] = await tx
          .update(tables.capsuleBranches)
          .set({
            status: 'cleanup_required',
            runtimeIp: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(tables.capsuleBranches.id, source.id),
              eq(tables.capsuleBranches.ownerId, operation.ownerId),
              eq(tables.capsuleBranches.capsuleId, operation.capsuleId),
              eq(tables.capsuleBranches.status, 'snapshotting'),
            ),
          )
          .returning()
        if (!branch) {
          throw new IncusError('Failed to fence the source branch after snapshot uncertainty.', 'CONFLICT')
        }
        branches.push(branch)
      }
      return this.transition(operation, capsule, branches)
    })
  }

  private async resourceTransition(
    operationId: string,
    resourceId: string,
    expected: SnapshotResource['status'],
    status: SnapshotResource['status'],
  ): Promise<SnapshotResource> {
    return await this.persistence.db.transaction(async tx => {
      const scope = await this.prove(tx, await this.lock(tx, operationId))
      this.assertRunning(scope.operation)
      const resource = scope.resources.find(candidate => candidate.id === resourceId)
      if (
        scope.operation.providerMutationStartedAt === null ||
        !resource ||
        resource.status !== expected ||
        !pristine(resource)
      ) {
        throw new IncusError('Snapshot resource transition lacks valid operation and provider evidence.', 'CONFLICT', {
          operationId,
          resourceId,
          expected,
          status,
        })
      }
      const resources = this.persistence.tables.capsuleSnapshotCreateResources
      const [updated] = await tx
        .update(resources)
        .set({
          status,
          updatedAt: new Date(),
        })
        .where(
          and(eq(resources.id, resourceId), eq(resources.operationId, operationId), eq(resources.status, expected)),
        )
        .returning()
      if (!updated) {
        throw new IncusError('Failed to persist snapshot resource outcome.', 'CONFLICT', {
          operationId,
          resourceId,
        })
      }
      return updated
    })
  }

  private async prove(tx: Transaction<TDatabase>, locked: LockedSnapshot): Promise<ProvenSnapshot> {
    this.assertLedger(locked)
    const { operation, capsule, branch, extension } = locked
    if (
      !branch ||
      !extension ||
      extension.snapshotId !== null ||
      capsule.lifecycleStatus !== 'active' ||
      capsule.archivedAt !== null ||
      capsule.destroyedAt !== null ||
      branch.status !== 'snapshotting' ||
      branch.runtimeIp !== null ||
      branch.name !== extension.sourceBranchName ||
      branch.resourceInventoryDigest !== extension.sourceBranchResourceInventoryDigest
    ) {
      throw new IncusError('Create Snapshot no longer has intact accepted branch state.', 'CONFLICT', {
        operationId: operation.id,
      })
    }
    await this.previews.assertBranchWithdrawn(tx, operation.ownerId, operation.capsuleId, branch.id)
    const blueprint = verifyCapsuleBlueprintPin(extension.blueprintPin)
    const rootfsImagePin = readRootfs(extension.rootfsImagePin, blueprint.blueprint.image_alias, {
      operationId: operation.id,
    })
    const provenance = await this.provenance.lock(tx, branch)
    if (
      blueprint.blueprint.schema_version !== extension.blueprintSchemaVersion ||
      blueprint.name !== extension.blueprintName ||
      blueprint.digest !== extension.blueprintDigest ||
      blueprint.name !== provenance.blueprint.name ||
      blueprint.digest !== provenance.blueprint.digest ||
      !sameRootfs(rootfsImagePin, provenance.rootfsImagePin)
    ) {
      throw new IncusError('Create Snapshot reconstruction pins disagree with source provenance.', 'CONFLICT', {
        operationId: operation.id,
      })
    }
    const plan = this.planner.create({
      operationId: operation.id,
      branch,
      provenance,
      resources: await this.inventory(tx, branch.id),
    })
    const table = this.persistence.tables.capsuleSnapshotCreateResources
    const resources = await tx
      .select()
      .from(table)
      .where(eq(table.operationId, operation.id))
      .orderBy(asc(table.blueprintVolumeName), asc(table.id))
      .for('update')
    this.planner.assertResources(operation.id, plan, resources)
    if (
      (resources.length === 0 && operation.providerMutationStartedAt !== null) ||
      (operation.providerMutationStartedAt === null &&
        resources.some(resource => resource.status !== 'planned' || !pristine(resource)))
    ) {
      throw new IncusError('Snapshot provider intent contradicts its managed-volume accounting.', 'CONFLICT', {
        operationId: operation.id,
        resourceCount: resources.length,
        providerIntentRecorded: operation.providerMutationStartedAt !== null,
      })
    }
    return {
      ...locked,
      branch,
      extension,
      resources,
      execution: {
        operationId: operation.id,
        ownerId: operation.ownerId,
        capsuleId: operation.capsuleId,
        sourceBranchId: branch.id,
        sourceBranchName: extension.sourceBranchName,
        blueprint,
        rootfsImagePin,
        plan,
      },
    }
  }

  private async lock(tx: Transaction<TDatabase>, operationId: string): Promise<LockedSnapshot> {
    const tables = this.persistence.tables
    const [identity] = await tx
      .select({
        ownerId: tables.capsuleOperations.ownerId,
        capsuleId: tables.capsuleOperations.capsuleId,
        type: tables.capsuleOperations.type,
      })
      .from(tables.capsuleOperations)
      .where(eq(tables.capsuleOperations.id, operationId))
      .limit(1)
    if (!identity || identity.type !== CapsuleOperationType.SNAPSHOT_CREATE) {
      throw new IncusError('Create Snapshot operation not found.', 'NOT_FOUND', {
        operationId,
      })
    }
    const capsule = await this.lockCapsule(tx, identity.ownerId, identity.capsuleId)
    const [extension] = await tx
      .select()
      .from(tables.capsuleSnapshotCreateOperations)
      .where(eq(tables.capsuleSnapshotCreateOperations.operationId, operationId))
      .limit(1)
    const branch = extension
      ? await this.lockBranch(tx, identity.ownerId, identity.capsuleId, extension.sourceBranchId)
      : null
    const [operation] = await tx
      .select()
      .from(tables.capsuleOperations)
      .where(
        and(
          eq(tables.capsuleOperations.id, operationId),
          eq(tables.capsuleOperations.type, CapsuleOperationType.SNAPSHOT_CREATE),
          eq(tables.capsuleOperations.ownerId, identity.ownerId),
          eq(tables.capsuleOperations.capsuleId, identity.capsuleId),
        ),
      )
      .for('update')
      .limit(1)
    const [lockedExtension] = await tx
      .select()
      .from(tables.capsuleSnapshotCreateOperations)
      .where(eq(tables.capsuleSnapshotCreateOperations.operationId, operationId))
      .for('update')
      .limit(1)
    if (!operation || lockedExtension?.sourceBranchId !== extension?.sourceBranchId) {
      throw new IncusError('Create Snapshot identity changed while acquiring its locks.', 'CONFLICT', {
        operationId,
      })
    }
    return {
      operation,
      capsule,
      branch,
      extension: lockedExtension ?? null,
    }
  }

  private async lockCapsule(tx: Transaction<TDatabase>, ownerId: string, capsuleId: string): Promise<Capsule> {
    const capsules = this.persistence.tables.capsules
    const [capsule] = await tx
      .select()
      .from(capsules)
      .where(and(eq(capsules.id, capsuleId), eq(capsules.ownerId, ownerId)))
      .for('update')
      .limit(1)
    if (!capsule) {
      throw new IncusError('Capsule not found or access denied.', 'NOT_FOUND', {
        capsuleId,
      })
    }
    return capsule
  }

  private async lockBranch(
    tx: Transaction<TDatabase>,
    ownerId: string,
    capsuleId: string,
    branchId: string,
  ): Promise<Branch | null> {
    const branches = this.persistence.tables.capsuleBranches
    const [branch] = await tx
      .select()
      .from(branches)
      .where(and(eq(branches.id, branchId), eq(branches.ownerId, ownerId), eq(branches.capsuleId, capsuleId)))
      .for('update')
      .limit(1)
    return branch ?? null
  }

  private async inventory(tx: Transaction<TDatabase>, branchId: string) {
    const resources = this.persistence.tables.capsuleBranchResources
    return await tx
      .select()
      .from(resources)
      .where(eq(resources.branchId, branchId))
      .orderBy(asc(resources.id))
      .for('update')
  }

  private async restoreBranch(tx: Transaction<TDatabase>, branch: Branch, now: Date): Promise<Branch> {
    const branches = this.persistence.tables.capsuleBranches
    const [offline] = await tx
      .update(branches)
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
          eq(branches.id, branch.id),
          eq(branches.ownerId, branch.ownerId),
          eq(branches.capsuleId, branch.capsuleId),
          eq(branches.status, 'snapshotting'),
        ),
      )
      .returning()
    if (!offline) {
      throw new IncusError('Failed to restore the fenced source branch to offline.', 'CONFLICT', {
        branchId: branch.id,
      })
    }
    return offline
  }

  private async replay(
    tx: Transaction<TDatabase>,
    input: SnapshotAcceptanceInput,
    capsule: Capsule,
  ): Promise<SnapshotAcceptance | null> {
    const tables = this.persistence.tables
    const [operation] = await tx
      .select()
      .from(tables.capsuleOperations)
      .where(
        and(
          eq(tables.capsuleOperations.ownerId, input.ownerId),
          eq(tables.capsuleOperations.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1)
    if (!operation) {
      return null
    }
    assertOperationReplayIdentity(
      {
        id: operation.id,
        type: operation.type,
        requestHash: operation.requestHash,
        actor: {
          type: operation.actorType,
          id: operation.actorId,
        },
      },
      {
        operationType: CapsuleOperationType.SNAPSHOT_CREATE,
        actor: input.actor,
        requestHash: input.requestHash,
        requestDescription: 'Create Snapshot',
      },
    )
    const [extension] = await tx
      .select()
      .from(tables.capsuleSnapshotCreateOperations)
      .where(eq(tables.capsuleSnapshotCreateOperations.operationId, operation.id))
      .limit(1)
    if (!extension || operation.capsuleId !== input.capsuleId || extension.sourceBranchId !== input.sourceBranchId) {
      throw new IncusError('Create Snapshot replay has contradictory accepted identity.', 'CONFLICT')
    }
    const blueprint = verifyCapsuleBlueprintPin(extension.blueprintPin)
    readRootfs(extension.rootfsImagePin, blueprint.blueprint.image_alias, {
      operationId: operation.id,
    })
    if (
      extension.blueprintSchemaVersion !== blueprint.blueprint.schema_version ||
      extension.blueprintName !== blueprint.name ||
      extension.blueprintDigest !== blueprint.digest
    ) {
      throw new IncusError('Create Snapshot replay has contradictory reconstruction pins.', 'CONFLICT')
    }
    if (operation.status === 'completed') {
      if (extension.snapshotId === null) {
        throw new IncusError('Completed Create Snapshot operation has no committed snapshot.', 'CONFLICT')
      }
      await this.snapshots.read(tx, input.ownerId, input.capsuleId, extension.snapshotId)
    } else if (extension.snapshotId !== null) {
      throw new IncusError('Uncompleted Create Snapshot operation references committed history.', 'CONFLICT')
    }
    return {
      newlyAccepted: false,
      receipt: this.receipt(operation, extension.sourceBranchId, extension.sourceBranchName, true),
      ...this.transition(operation, capsule, []),
    }
  }

  /**
   * Claim and failure classification share the same nonterminal ledger proof.
   * Contradictory terminal evidence cannot authorize execution or restoration.
   */
  private assertLedger(scope: LockedSnapshot): void {
    const { operation, capsule, extension, branch } = scope
    if (
      operation.type !== CapsuleOperationType.SNAPSHOT_CREATE ||
      operation.ownerId !== capsule.ownerId ||
      operation.capsuleId !== capsule.id ||
      !isNonterminal(operation.status) ||
      operation.completedAt !== null ||
      operation.failedAt !== null ||
      operation.failureCode !== null ||
      operation.failureMessage !== null ||
      operation.failureDetails !== null ||
      (operation.status === 'accepted' &&
        (operation.executionStartedAt !== null || operation.providerMutationStartedAt !== null)) ||
      (operation.status === 'running' && operation.executionStartedAt === null) ||
      (extension !== null && extension.operationId !== operation.id) ||
      (branch !== null &&
        (branch.ownerId !== operation.ownerId ||
          branch.capsuleId !== operation.capsuleId ||
          branch.id !== extension?.sourceBranchId))
    ) {
      throw new IncusError(
        'Create Snapshot contains contradictory operation or source identity evidence.',
        'CONFLICT',
        {
          operationId: operation.id,
          operationStatus: operation.status,
          capsuleId: operation.capsuleId,
          sourceBranchId: extension?.sourceBranchId ?? null,
        },
      )
    }
  }

  private assertRunning(operation: Operation): void {
    if (
      operation.type !== CapsuleOperationType.SNAPSHOT_CREATE ||
      operation.status !== 'running' ||
      operation.executionStartedAt === null ||
      operation.completedAt !== null ||
      operation.failedAt !== null ||
      operation.failureCode !== null ||
      operation.failureMessage !== null ||
      operation.failureDetails !== null
    ) {
      throw new IncusError('Create Snapshot is not eligible for execution.', 'CONFLICT', {
        operationId: operation.id,
      })
    }
  }

  private receipt(operation: Operation, sourceBranchId: string, sourceBranchName: string, replayed: boolean) {
    return CapsuleSnapshotCreateReceiptSchema.parse({
      operationId: operation.id,
      operationType: CapsuleOperationType.SNAPSHOT_CREATE,
      operationStatus: operation.status,
      capsuleId: operation.capsuleId,
      sourceBranchId,
      sourceBranchName,
      replayed,
    })
  }

  private transition(operation: Operation, capsule: Capsule, branches: SnapshotBranch[]): SnapshotTransition {
    return {
      operation: toCapsuleOperationTransition({
        ownerId: operation.ownerId,
        operationId: operation.id,
        operationType: CapsuleOperationType.SNAPSHOT_CREATE,
        operationStatus: operation.status,
        capsuleId: operation.capsuleId,
      }),
      capsule: toCapsuleLifecycleState({
        capsuleId: capsule.id,
        lifecycleStatus: capsule.lifecycleStatus,
        archivedAt: capsule.archivedAt,
        destroyedAt: capsule.destroyedAt,
      }),
      branches,
    }
  }
}
