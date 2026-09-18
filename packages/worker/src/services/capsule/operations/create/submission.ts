import {
  CapsuleOperationType,
  type CapsuleBlueprintRegistry,
  type CapsuleCreateReceipt,
  type CapsuleTables,
} from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { createOperationRequestHash } from '../shared'
import type { OperationSupervisor } from '../../../../coordination'
import type { IncusImagesClient } from '../../../../incus/client/images'
import type { CapsuleBranchEventPublisher } from '../../events/branch'
import type { CapsuleLifecycleEventPublisher, CapsuleOperationEventPublisher } from '../../events'
import type { CapsuleCreateExecutor } from './executor'
import type { CapsuleCreateRepository } from './persistence/repository'
import type { CapsuleCreateSubmissionInput } from './types'

interface CapsuleCreateRequestIdentity {
  operationType: typeof CapsuleOperationType.CREATE
  actor: CapsuleCreateSubmissionInput['actor']
  rootBranchName: string
  blueprintName: string
  blueprintDigest: string
  cpu: string
  memory: string
}

/**
 * Accepts or replays capsule creation and schedules only newly accepted work.
 *
 * Mutable blueprint catalog state is consulted only after the repository has
 * confirmed that no durable idempotent replay exists. Once accepted, the
 * executor reloads the immutable blueprint pin from PostgreSQL.
 */
export class CapsuleCreateSubmissionService<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly repository: CapsuleCreateRepository<TDatabase, TTables>,
    private readonly executor: CapsuleCreateExecutor<TDatabase, TTables>,
    private readonly supervisor: OperationSupervisor,
    private readonly blueprints: CapsuleBlueprintRegistry,
    private readonly images: IncusImagesClient,
    private readonly operationEvents: CapsuleOperationEventPublisher,
    private readonly lifecycleEvents: CapsuleLifecycleEventPublisher,
    private readonly branchEvents: CapsuleBranchEventPublisher,
  ) {}

  public async submit(input: CapsuleCreateSubmissionInput): Promise<CapsuleCreateReceipt> {
    const requestHash = createOperationRequestHash(
      {
        operationType: CapsuleOperationType.CREATE,
        actor: input.actor,
        rootBranchName: input.rootBranchName,
        blueprintName: input.blueprintName,
        blueprintDigest: input.blueprintDigest,
        cpu: input.cpu,
        memory: input.memory,
      } satisfies CapsuleCreateRequestIdentity,
      'capsule create request',
    )

    /**
     * This preflight is intentionally outside acceptance. A valid replay must
     * not depend on the mutable blueprint catalog still containing the original
     * definition.
     */
    const replay = await this.repository.findReplay(input.ownerId, input.actor, input.idempotencyKey, requestHash)
    if (replay) {
      return replay.receipt
    }

    const blueprintPin = this.blueprints.pin(input.blueprintName, input.blueprintDigest)
    const rootfsImagePin = await this.images.resolve(blueprintPin.blueprint.image_alias)
    /**
     * The repository repeats replay detection during acceptance so concurrent
     * submissions remain race-safe after the preflight lookup.
     */
    const acceptance = await this.repository.accept({
      ...input,
      requestHash,
      blueprintPin,
      rootfsImagePin,
    })
    if (!acceptance.newlyAccepted) {
      return acceptance.receipt
    }
    this.operationEvents.publishChanged(acceptance.operation)
    this.lifecycleEvents.publishChanged(acceptance.operation.ownerId, acceptance.capsule)
    this.branchEvents.publishStateChanged(
      acceptance.operation.ownerId,
      acceptance.branch.capsuleId,
      acceptance.branch.name,
      acceptance.branch.status,
    )
    const operationId = acceptance.receipt.operationId
    const executor = this.executor

    // A false result leaves the durable operation accepted. The next Worker
    // startup will classify it without issuing provider mutations.
    this.supervisor.schedule(operationId, () => executor.execute(operationId))

    return acceptance.receipt
  }
}
