import {
  CapsuleBranchResourceInventoryDigestSchema,
  CapsuleOperationStatus,
  CapsuleOperationType,
  verifyCapsuleBlueprintPin,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import { CapsuleSnapshotStore } from '../../../snapshot/store'
import { readRootfs, sameRootfs } from '../../shared'
import type { ForkSource } from '../types'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

type ForkOperation = CapsuleTables['capsuleOperations']['$inferSelect']
type ForkExtension = CapsuleTables['capsuleForkOperations']['$inferSelect']
type ForkBranch = CapsuleTables['capsuleBranches']['$inferSelect']

/**
 * Nonterminal ledger consistency is independent of resource progress.
 *
 * Contradictory completion or failure evidence must not authorize a new claim,
 * provider intent, compensated failure, or ordinary pre-provider failure.
 */
export function assertForkLedger(operation: ForkOperation): void {
  if (
    operation.type !== CapsuleOperationType.FORK ||
    (operation.status !== CapsuleOperationStatus.ACCEPTED && operation.status !== CapsuleOperationStatus.RUNNING) ||
    operation.completedAt !== null ||
    operation.failedAt !== null ||
    operation.failureCode !== null ||
    operation.failureMessage !== null ||
    operation.failureDetails !== null ||
    (operation.status === CapsuleOperationStatus.ACCEPTED &&
      (operation.executionStartedAt !== null || operation.providerMutationStartedAt !== null)) ||
    (operation.status === CapsuleOperationStatus.RUNNING && operation.executionStartedAt === null)
  ) {
    throw new IncusError('Capsule fork contains contradictory nonterminal operation evidence.', 'CONFLICT', {
      operationId: operation.id,
      operationType: operation.type,
      operationStatus: operation.status,
    })
  }
}

/**
 * Proves the fork's local immutable target without consulting source history.
 *
 * Cleanup may fence only a branch that passes this identity check. A missing or
 * contradictory target cannot authorize updates to an unrelated branch.
 */
export function assertForkIdentity(
  operation: Pick<ForkOperation, 'id' | 'ownerId' | 'capsuleId' | 'type'>,
  extension: ForkExtension,
  branch: ForkBranch,
) {
  if (operation.type !== CapsuleOperationType.FORK) {
    throw new IncusError('Fork extension is attached to a non-fork operation.', 'CONFLICT', {
      operationId: operation.id,
      operationType: operation.type,
    })
  }
  const blueprint = verifyCapsuleBlueprintPin(extension.blueprintPin)
  const rootfsImagePin = readRootfs(extension.rootfsImagePin, blueprint.blueprint.image_alias, {
    operationId: operation.id,
    sourceSnapshotId: extension.sourceSnapshotId,
    targetBranchId: branch.id,
  })
  const inventory = CapsuleBranchResourceInventoryDigestSchema.safeParse(extension.targetBranchResourceInventoryDigest)
  const contradictions: string[] = []
  if (extension.operationId !== operation.id) {
    contradictions.push('operation_id_mismatch')
  }
  if (extension.targetBranchId !== branch.id) {
    contradictions.push('target_branch_id_mismatch')
  }
  if (extension.targetBranchName !== branch.name) {
    contradictions.push('target_branch_name_mismatch')
  }
  if (branch.ownerId !== operation.ownerId) {
    contradictions.push('target_branch_owner_mismatch')
  }
  if (branch.capsuleId !== operation.capsuleId) {
    contradictions.push('target_branch_capsule_mismatch')
  }
  if (branch.isRootBranch) {
    contradictions.push('target_branch_is_root')
  }
  if (branch.cpu !== extension.cpu) {
    contradictions.push('target_branch_cpu_mismatch')
  }
  if (branch.memory !== extension.memory) {
    contradictions.push('target_branch_memory_mismatch')
  }
  if (branch.blueprintName !== extension.blueprintName) {
    contradictions.push('target_branch_blueprint_name_mismatch')
  }
  if (branch.blueprintDigest !== extension.blueprintDigest) {
    contradictions.push('target_branch_blueprint_digest_mismatch')
  }
  if (!inventory.success || branch.resourceInventoryDigest !== extension.targetBranchResourceInventoryDigest) {
    contradictions.push('target_branch_inventory_digest_mismatch')
  }
  if (blueprint.blueprint.schema_version !== extension.blueprintSchemaVersion) {
    contradictions.push('blueprint_schema_version_mismatch')
  }
  if (blueprint.name !== extension.blueprintName) {
    contradictions.push('blueprint_name_mismatch')
  }
  if (blueprint.digest !== extension.blueprintDigest) {
    contradictions.push('blueprint_digest_mismatch')
  }
  if (contradictions.length > 0) {
    throw new IncusError('Capsule fork immutable target identity is internally inconsistent.', 'CONFLICT', {
      operationId: operation.id,
      sourceSnapshotId: extension.sourceSnapshotId,
      targetBranchId: branch.id,
      contradictions,
    })
  }
  return {
    blueprint,
    rootfsImagePin,
  }
}

/**
 * Validates immutable fork-operation evidence against the selected source
 * snapshot and provisional target branch.
 *
 * PostgreSQL proves row identity through foreign keys. This policy additionally
 * proves operation discriminators and immutable cross-table agreement.
 */
export function assertForkEvidence(
  operation: Pick<ForkOperation, 'id' | 'ownerId' | 'capsuleId' | 'type'>,
  extension: ForkExtension,
  source: ForkSource,
  branch: ForkBranch,
): void {
  const { blueprint, rootfsImagePin } = assertForkIdentity(operation, extension, branch)
  const contradictions: string[] = []
  if (source.ownerId !== operation.ownerId) {
    contradictions.push('source_owner_mismatch')
  }
  if (source.capsuleId !== operation.capsuleId) {
    contradictions.push('source_capsule_mismatch')
  }
  if (extension.sourceSnapshotId !== source.snapshotId) {
    contradictions.push('source_snapshot_id_mismatch')
  }
  if (blueprint.name !== source.blueprint.name || blueprint.digest !== source.blueprint.digest) {
    contradictions.push('source_blueprint_mismatch')
  }
  if (!sameRootfs(rootfsImagePin, source.rootfsImagePin)) {
    contradictions.push('source_rootfs_image_mismatch')
  }
  if (contradictions.length > 0) {
    throw new IncusError('Capsule fork immutable evidence disagrees with its committed source snapshot.', 'CONFLICT', {
      operationId: operation.id,
      sourceSnapshotId: source.snapshotId,
      targetBranchId: branch.id,
      contradictions,
    })
  }
}

/**
 * Consumes the existing committed restoration reader inside the caller's
 * capsule-first transaction.
 *
 * Managed-volume clone authority comes only from references validated by
 * CapsuleSnapshotStore. Fork does not maintain another snapshot validator or
 * inspect provider state to repair missing restoration evidence.
 */
export class ForkSourcePersistence<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  private readonly snapshots: CapsuleSnapshotStore<TDatabase, TTables>

  constructor(persistence: CapsulePersistence<TDatabase, TTables>) {
    this.snapshots = new CapsuleSnapshotStore(persistence)
  }

  public async read(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    ownerId: string,
    capsuleId: string,
    snapshotId: string,
  ): Promise<ForkSource> {
    const snapshot = await this.snapshots.read(tx, ownerId, capsuleId, snapshotId)
    return {
      ownerId,
      snapshotId: snapshot.id,
      capsuleId: snapshot.capsuleId,
      blueprint: snapshot.blueprintPin,
      rootfsImagePin: snapshot.rootfsImagePin,
      resources: snapshot.resources,
    }
  }
}
