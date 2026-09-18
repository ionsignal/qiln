import { and, eq } from 'drizzle-orm'
import { digestCanonicalJsonValue, type CapsulePersistence, type CapsuleTables } from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from '../../../failures'
import { toJsonObject } from '../../../persistence/json'
import type { CapsuleCreateResourceInput } from './types'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

type CapsuleCreateResourceRow<TTables extends CapsuleTables> = TTables['capsuleBranchResources']['$inferSelect']
type CapsuleCreateResourceStatus<TTables extends CapsuleTables> = CapsuleCreateResourceRow<TTables>['status']
type CapsuleCreateResourceUpdate<TTables extends CapsuleTables> = Pick<
  CapsuleCreateResourceRow<TTables>,
  'status' | 'lastOperationId' | 'updatedAt' | 'failureCode' | 'failureMessage' | 'failureDetails'
>
type CapsuleCreateTransaction<TDatabase extends PostgresJsDatabase> = Parameters<
  Parameters<TDatabase['transaction']>[0]
>[0]

/**
 * Transitions pre-materialized create resources without inserting identities.
 *
 * Every transition proves the running create operation, provider fence, branch
 * ownership, immutable resource identity, and expected accounting state.
 * Provider calls remain outside these transactions.
 */
export class CapsuleCreateResourceStore<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(private readonly persistence: CapsulePersistence<TDatabase, TTables>) {}

  public async begin(input: CapsuleCreateResourceInput): Promise<string> {
    return await this.transition(input, ['planned'], 'creating')
  }

  public async created(input: CapsuleCreateResourceInput): Promise<void> {
    await this.transition(input, ['creating'], 'created')
  }

  public async adopt(input: CapsuleCreateResourceInput): Promise<void> {
    const project = input.resourceType === 'incus_project' && input.cleanupPolicy === 'retain'
    const bind = input.resourceType === 'bind_mount' && input.cleanupPolicy === 'external'
    if (!project && !bind) {
      throw new IncusError('Only retained projects and external bind mounts may be adopted.', 'VALIDATION_ERROR', {
        resourceKey: input.resourceKey,
      })
    }
    await this.transition(input, [project ? 'creating' : 'planned'], 'adopted')
  }

  public async failed(
    input: CapsuleCreateResourceInput,
    error: unknown,
    context?: Record<string, unknown>,
  ): Promise<void> {
    await this.transition(input, ['creating'], 'error', error, context)
  }

  public async deleting(input: CapsuleCreateResourceInput): Promise<void> {
    this.assertDirect(input)
    await this.transition(input, ['created'], 'deleting')
  }

  public async deleted(input: CapsuleCreateResourceInput, outcome: 'deleted' | 'missing'): Promise<void> {
    this.assertDirect(input)
    await this.transition(input, ['deleting'], outcome)
  }

  public async deleteFailed(
    input: CapsuleCreateResourceInput,
    error: unknown,
    context?: Record<string, unknown>,
  ): Promise<void> {
    this.assertDirect(input)
    await this.transition(input, ['deleting'], 'error', error, context)
  }

  /**
   * The compensator must positively remove the backing resource first.
   *
   * A derived file has no independent provider deletion operation.
   */
  public async compensated(input: CapsuleCreateResourceInput): Promise<void> {
    if (input.resourceType !== 'provisioning_file' || input.cleanupPolicy !== 'delete_with_branch') {
      throw new IncusError('Derived compensation requires a create-owned provisioning file.', 'VALIDATION_ERROR', {
        resourceKey: input.resourceKey,
      })
    }
    await this.transition(input, ['planned', 'creating', 'created', 'error'], 'deleted')
  }

  private async transition(
    input: CapsuleCreateResourceInput,
    expected: readonly CapsuleCreateResourceStatus<TTables>[],
    status: CapsuleCreateResourceStatus<TTables>,
    error?: unknown,
    context?: Record<string, unknown>,
  ): Promise<string> {
    return await this.persistence.db.transaction(async tx => {
      await this.lockCreate(tx, input)
      const resources = this.persistence.tables.capsuleBranchResources
      const [resource] = await tx
        .select()
        .from(resources)
        .where(and(eq(resources.branchId, input.branchId), eq(resources.resourceKey, input.resourceKey)))
        .for('update')
        .limit(1)
      if (!resource) {
        throw new IncusError('Required planned capsule resource was not found.', 'CONFLICT', {
          operationId: input.operationId,
          branchId: input.branchId,
          resourceKey: input.resourceKey,
        })
      }
      this.assertIdentity(resource, input)
      if (!expected.includes(resource.status)) {
        throw new IncusError('Capsule resource is not in the expected create accounting state.', 'CONFLICT', {
          operationId: input.operationId,
          resourceId: resource.id,
          resourceKey: resource.resourceKey,
          expected,
          actual: resource.status,
        })
      }
      if (
        resource.status !== 'error' &&
        (resource.failureCode !== null || resource.failureMessage !== null || resource.failureDetails !== null)
      ) {
        throw new IncusError('Capsule resource contains contradictory failure evidence.', 'CONFLICT', {
          operationId: input.operationId,
          resourceId: resource.id,
        })
      }
      const update: CapsuleCreateResourceUpdate<TTables> = {
        status,
        lastOperationId: input.operationId,
        updatedAt: new Date(),
        failureCode: null,
        failureMessage: null,
        failureDetails: null,
      }
      if (status === 'error') {
        const details = createFailureDetails(error, context)
        update.failureCode = failureCodeFromUnknown(error)
        update.failureMessage = failureMessageFromUnknown(error, 'Capsule resource operation failed.')
        update.failureDetails = details === undefined ? null : toJsonObject(details, 'capsule resource failure details')
      }
      const [updated] = await tx
        .update(resources)
        .set(update)
        .where(
          and(
            eq(resources.id, resource.id),
            eq(resources.status, resource.status),
            eq(resources.createdByOperationId, input.operationId),
            eq(resources.lastOperationId, input.operationId),
          ),
        )
        .returning({
          id: resources.id,
        })
      if (!updated) {
        throw new IncusError('Capsule resource transition conflicted with durable state.', 'CONFLICT', {
          operationId: input.operationId,
          resourceId: resource.id,
          status,
        })
      }
      return updated.id
    })
  }

  private async lockCreate(
    tx: CapsuleCreateTransaction<TDatabase>,
    input: CapsuleCreateResourceInput,
  ): Promise<void> {
    const { capsules, capsuleOperations, capsuleBranches, capsuleCreateOperations } = this.persistence.tables
    const [capsule] = await tx
      .select()
      .from(capsules)
      .where(and(eq(capsules.id, input.capsuleId), eq(capsules.ownerId, input.ownerId)))
      .for('update')
      .limit(1)
    const [operation] = await tx
      .select()
      .from(capsuleOperations)
      .where(eq(capsuleOperations.id, input.operationId))
      .for('update')
      .limit(1)
    const [extension] = await tx
      .select()
      .from(capsuleCreateOperations)
      .where(eq(capsuleCreateOperations.operationId, input.operationId))
      .for('update')
      .limit(1)
    const [branch] = await tx
      .select()
      .from(capsuleBranches)
      .where(eq(capsuleBranches.id, input.branchId))
      .for('update')
      .limit(1)
    if (
      !capsule ||
      capsule.lifecycleStatus !== 'provisioning' ||
      capsule.archivedAt !== null ||
      !operation ||
      operation.type !== 'create' ||
      operation.status !== 'running' ||
      operation.ownerId !== input.ownerId ||
      operation.capsuleId !== capsule.id ||
      operation.executionStartedAt === null ||
      operation.providerMutationStartedAt === null ||
      operation.completedAt !== null ||
      operation.failedAt !== null ||
      operation.failureCode !== null ||
      operation.failureMessage !== null ||
      operation.failureDetails !== null ||
      !extension ||
      extension.rootBranchId !== input.branchId ||
      extension.rootBranchName !== input.branchName ||
      !branch ||
      branch.ownerId !== input.ownerId ||
      branch.capsuleId !== capsule.id ||
      branch.name !== input.branchName ||
      !branch.isRootBranch ||
      branch.status !== 'provisioning' ||
      branch.resourceInventoryDigest === null
    ) {
      throw new IncusError(
        'Resource transition requires a fenced running create and its provisioning root branch.',
        'CONFLICT',
        {
          operationId: input.operationId,
          capsuleId: input.capsuleId,
          branchId: input.branchId,
        },
      )
    }
  }

  private assertIdentity(
    resource: CapsuleCreateResourceRow<TTables>,
    input: CapsuleCreateResourceInput,
  ): void {
    const metadataMatches =
      digestCanonicalJsonValue(resource.metadata, { context: 'persisted create resource metadata' }) ===
      digestCanonicalJsonValue(input.metadata, { context: 'expected create resource metadata' })
    if (
      resource.ownerId !== input.ownerId ||
      resource.branchId !== input.branchId ||
      resource.branchName !== input.branchName ||
      resource.createdByOperationId !== input.operationId ||
      resource.lastOperationId !== input.operationId ||
      resource.provider !== 'incus' ||
      resource.resourceType !== input.resourceType ||
      resource.resourceKey !== input.resourceKey ||
      resource.blueprintVolumeName !== input.blueprintVolumeName ||
      resource.cleanupPolicy !== input.cleanupPolicy ||
      !metadataMatches
    ) {
      throw new IncusError('Capsule resource does not match its immutable create identity.', 'CONFLICT', {
        operationId: input.operationId,
        branchId: input.branchId,
        resourceId: resource.id,
        resourceKey: input.resourceKey,
      })
    }
  }

  private assertDirect(input: CapsuleCreateResourceInput): void {
    if (
      input.cleanupPolicy !== 'delete_with_branch' ||
      (input.resourceType !== 'incus_instance' && input.resourceType !== 'zfs_volume')
    ) {
      throw new IncusError('Create compensation may delete only managed instances and volumes.', 'VALIDATION_ERROR', {
        operationId: input.operationId,
        resourceKey: input.resourceKey,
      })
    }
  }
}
