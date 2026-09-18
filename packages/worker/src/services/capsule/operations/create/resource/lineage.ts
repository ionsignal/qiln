import {
  CapsuleOperationType,
  verifyCapsuleBlueprintPin,
  type CapsuleBlueprintPin,
  type CapsuleRootfsImagePin,
  type CapsuleTables,
} from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import { readRootfs } from '../../shared/rootfs'

export type CapsuleCreateOperationRow<TTables extends CapsuleTables = CapsuleTables> =
  TTables['capsuleOperations']['$inferSelect']

export type CapsuleCreateExtensionRow<TTables extends CapsuleTables = CapsuleTables> =
  TTables['capsuleCreateOperations']['$inferSelect']

export type CapsuleCreateBranchRow<TTables extends CapsuleTables = CapsuleTables> =
  TTables['capsuleBranches']['$inferSelect']

export interface ValidatedCapsuleCreateLineage<TTables extends CapsuleTables = CapsuleTables> {
  extension: CapsuleCreateExtensionRow<TTables>
  rootBranch: CapsuleCreateBranchRow<TTables>
  blueprintPin: CapsuleBlueprintPin
  rootfsImagePin: CapsuleRootfsImagePin
}

export type CapsuleCreateLineageInspection<TTables extends CapsuleTables = CapsuleTables> =
  | {
      valid: true
      lineage: ValidatedCapsuleCreateLineage<TTables>
    }
  | {
      valid: false
      contradictions: string[]
    }

/**
 * Validates immutable create-operation lineage without performing persistence
 * or provider work.
 *
 * PostgreSQL foreign keys prove row references but cannot prove that the base
 * operation discriminator, root branch, Blueprint pin, and rootfs pin agree.
 *
 * Each inspection verifies its pins once. Callers at independent authority
 * boundaries inspect their own durable input rather than sharing a long-lived
 * validation cache.
 */
export class CapsuleCreateResourceLineage<TTables extends CapsuleTables = CapsuleTables> {
  public validate(
    operation: Pick<CapsuleCreateOperationRow<TTables>, 'id' | 'ownerId' | 'capsuleId' | 'type'>,
    extension: CapsuleCreateExtensionRow<TTables>,
    rootBranches: readonly CapsuleCreateBranchRow<TTables>[],
  ): ValidatedCapsuleCreateLineage<TTables> {
    const inspection = this.inspect(operation, extension, rootBranches)
    if (!inspection.valid) {
      throw new IncusError(
        'Capsule create operation extension does not match its durable operation and root branch.',
        'CONFLICT',
        {
          operationId: operation.id,
          capsuleId: operation.capsuleId,
          rootBranchId: extension.rootBranchId,
          contradictions: inspection.contradictions,
        },
      )
    }
    return inspection.lineage
  }

  /**
   * Returns contradictions instead of throwing for incomplete lineage so
   * classification can conservatively retain cleanup-required state.
   */
  public inspect(
    operation: Pick<CapsuleCreateOperationRow<TTables>, 'id' | 'ownerId' | 'capsuleId' | 'type'>,
    extension: CapsuleCreateExtensionRow<TTables> | null,
    rootBranches: readonly CapsuleCreateBranchRow<TTables>[],
  ): CapsuleCreateLineageInspection<TTables> {
    const contradictions: string[] = []
    if (operation.type !== CapsuleOperationType.CREATE) {
      contradictions.push('base_operation_type_is_not_create')
    }
    if (rootBranches.length !== 1) {
      contradictions.push('root_branch_count_invalid')
    }
    if (!extension) {
      contradictions.push('create_extension_missing')
      return {
        valid: false,
        contradictions,
      }
    }
    if (extension.operationId !== operation.id) {
      contradictions.push('create_extension_operation_id_mismatch')
    }
    const rootBranch = rootBranches.find(branch => branch.id === extension.rootBranchId)
    if (!rootBranch) {
      contradictions.push('create_extension_root_branch_reference_mismatch')
      return {
        valid: false,
        contradictions,
      }
    }
    if (!rootBranch.isRootBranch) {
      contradictions.push('referenced_branch_is_not_root')
    }
    if (rootBranch.ownerId !== operation.ownerId) {
      contradictions.push('root_branch_owner_mismatch')
    }
    if (rootBranch.capsuleId !== operation.capsuleId) {
      contradictions.push('root_branch_capsule_mismatch')
    }
    if (rootBranch.name !== extension.rootBranchName) {
      contradictions.push('root_branch_name_mismatch')
    }
    if (rootBranch.blueprintName !== extension.blueprintName) {
      contradictions.push('root_branch_blueprint_name_mismatch')
    }
    if (rootBranch.blueprintDigest !== extension.blueprintDigest) {
      contradictions.push('root_branch_blueprint_digest_mismatch')
    }
    if (rootBranch.cpu !== extension.cpu) {
      contradictions.push('root_branch_cpu_mismatch')
    }
    if (rootBranch.memory !== extension.memory) {
      contradictions.push('root_branch_memory_mismatch')
    }
    if (contradictions.length > 0) {
      return {
        valid: false,
        contradictions,
      }
    }
    try {
      const pin = this.pin(extension)
      return {
        valid: true,
        lineage: {
          extension,
          rootBranch,
          blueprintPin: pin.blueprintPin,
          rootfsImagePin: pin.rootfsImagePin,
        },
      }
    } catch {
      return {
        valid: false,
        contradictions: ['create_extension_immutable_input_invalid'],
      }
    }
  }

  private pin(extension: CapsuleCreateExtensionRow<TTables>): {
    blueprintPin: CapsuleBlueprintPin
    rootfsImagePin: CapsuleRootfsImagePin
  } {
    const blueprintPin = verifyCapsuleBlueprintPin(extension.blueprintPin)
    if (blueprintPin.name !== extension.blueprintName || blueprintPin.digest !== extension.blueprintDigest) {
      throw new IncusError('Pinned Blueprint does not match the immutable create identity.', 'CONFLICT', {
        operationId: extension.operationId,
        blueprintName: extension.blueprintName,
        blueprintDigest: extension.blueprintDigest,
        pinnedBlueprintName: blueprintPin.name,
        pinnedBlueprintDigest: blueprintPin.digest,
      })
    }
    return {
      blueprintPin,
      rootfsImagePin: readRootfs(extension.rootfsImagePin, blueprintPin.blueprint.image_alias, {
        operationId: extension.operationId,
        blueprintName: extension.blueprintName,
        blueprintDigest: extension.blueprintDigest,
      }),
    }
  }
}
