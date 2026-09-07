import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  type CapsuleActorReference,
  type CapsuleOperationRequestHash,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import { IncusError, isUniqueConstraintViolation } from '../../../../../errors'
import { assertOperationReplayIdentity } from '../../shared'
import { toCreateRepositoryResult } from './result'
import type { CapsuleOperationReader } from '../../shared'
import type { CreateCapsuleLineagePolicy } from '../policy/lineage'
import type { AcceptCreateCapsuleOperationInput, CreateCapsuleRepositoryResult } from '../types'
import type { CreateCapsuleLocks } from './locks'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

/**
 * Owns actor-bound replay and atomic create acceptance.
 *
 * Replay is checked before mutable Blueprint or image resolution by submission
 * and repeated here before acceptance. The unique idempotency constraint closes
 * the remaining race between concurrent requests.
 */
export class CreateCapsuleAcceptance<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly reader: CapsuleOperationReader<TDatabase, TTables>,
    private readonly locks: CreateCapsuleLocks<TDatabase, TTables>,
    private readonly lineage: CreateCapsuleLineagePolicy<TTables>,
  ) {}

  /**
   * Actor identity is checked independently from the request hash so another
   * principal cannot replay an owner's idempotency key.
   *
   * The locked reload also keeps the returned operation and aggregate state
   * consistent while an accepted create is executing.
   */
  public async findReplay(
    ownerId: string,
    actor: CapsuleActorReference,
    idempotencyKey: string,
    requestHash: CapsuleOperationRequestHash,
  ): Promise<CreateCapsuleRepositoryResult | null> {
    const existing = await this.reader.loadByOwnerAndIdempotencyKey(ownerId, idempotencyKey)
    if (!existing) {
      return null
    }
    assertOperationReplayIdentity(existing, {
      operationType: CapsuleOperationType.CREATE,
      actor,
      requestHash,
      requestDescription: 'capsule create',
    })
    return await this.persistence.db.transaction(async tx => {
      const operation = await this.locks.operation(tx, existing.id)
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
          operationType: CapsuleOperationType.CREATE,
          actor,
          requestHash,
          requestDescription: 'capsule create',
        },
      )
      if (operation.ownerId !== ownerId || operation.idempotencyKey !== idempotencyKey) {
        throw new IncusError(
          'Capsule create replay no longer matches its durable owner and idempotency key.',
          'CONFLICT',
          {
            operationId: operation.id,
          },
        )
      }
      const extension = await this.locks.extension(tx, operation.id)
      const capsule = await this.locks.capsule(tx, operation.ownerId, operation.capsuleId)
      const branches = await this.locks.rootBranches(tx, operation.capsuleId, extension.rootBranchId)
      const lineage = this.lineage.validate(operation, extension, branches)
      return toCreateRepositoryResult(operation, capsule, lineage.rootBranch, {
        newlyAccepted: false,
        replayed: true,
      })
    })
  }

  /**
   * Actor provenance, immutable input, capsule, operation, and provisional root
   * branch are committed together. Validation runs against the rows returned by
   * that transaction before acceptance can commit.
   */
  public async accept(input: AcceptCreateCapsuleOperationInput): Promise<CreateCapsuleRepositoryResult> {
    const replay = await this.findReplay(input.ownerId, input.actor, input.idempotencyKey, input.requestHash)
    if (replay) {
      return replay
    }
    const { capsules, capsuleOperations, capsuleBranches, capsuleCreateOperations } = this.persistence.tables
    try {
      return await this.persistence.db.transaction(async tx => {
        const now = new Date()
        const [capsule] = await tx
          .insert(capsules)
          .values({
            ownerId: input.ownerId,
            lifecycleStatus: 'provisioning',
            createdAt: now,
            updatedAt: now,
          })
          .returning()
        if (!capsule) {
          throw new IncusError('Failed to create the durable capsule aggregate.', 'API_ERROR')
        }
        const [operation] = await tx
          .insert(capsuleOperations)
          .values({
            ownerId: input.ownerId,
            actorType: input.actor.type,
            actorId: input.actor.id,
            capsuleId: capsule.id,
            type: CapsuleOperationType.CREATE,
            status: CapsuleOperationStatus.ACCEPTED,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            acceptedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
        if (!operation) {
          throw new IncusError('Failed to accept the durable capsule create operation.', 'API_ERROR')
        }
        const [rootBranch] = await tx
          .insert(capsuleBranches)
          .values({
            ownerId: input.ownerId,
            capsuleId: capsule.id,
            name: input.rootBranchName,
            cpu: input.cpu,
            memory: input.memory,
            blueprintName: input.blueprintName,
            blueprintDigest: input.blueprintDigest,
            status: 'provisioning',
            isRootBranch: true,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
        if (!rootBranch) {
          throw new IncusError('Failed to create the provisional capsule root branch.', 'API_ERROR')
        }
        const [extension] = await tx
          .insert(capsuleCreateOperations)
          .values({
            operationId: operation.id,
            rootBranchId: rootBranch.id,
            rootBranchName: input.rootBranchName,
            blueprintName: input.blueprintName,
            blueprintDigest: input.blueprintDigest,
            blueprintSnapshot: input.blueprintSnapshot,
            rootfsImagePin: input.rootfsImagePin,
            cpu: input.cpu,
            memory: input.memory,
          })
          .returning()
        if (!extension) {
          throw new IncusError('Failed to record immutable capsule create operation input.', 'API_ERROR', {
            operationId: operation.id,
            capsuleId: capsule.id,
            rootBranchId: rootBranch.id,
          })
        }
        const lineage = this.lineage.validate(operation, extension, [rootBranch])
        return toCreateRepositoryResult(operation, capsule, lineage.rootBranch, {
          newlyAccepted: true,
          replayed: false,
        })
      })
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) {
        throw error
      }

      /**
       * A concurrent request may have committed the same idempotency key after
       * the preflight lookup. Reloading here is the race-safe half of the
       * idempotency protocol.
       */
      const racedReplay = await this.findReplay(input.ownerId, input.actor, input.idempotencyKey, input.requestHash)
      if (racedReplay) {
        return racedReplay
      }
      throw new IncusError(
        `Capsule root branch '${input.rootBranchName}' conflicts with existing durable state.`,
        'CONFLICT',
        {
          ownerId: input.ownerId,
          rootBranchName: input.rootBranchName,
        },
      )
    }
  }
}
