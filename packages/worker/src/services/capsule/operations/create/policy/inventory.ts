import {
  CapsuleBranchResourceStatus,
  type CapsuleTables,
} from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import { assertCapsuleBranchResourceInventoryMatches } from '../../../resource/inventory'
import { createResourceInventoryEntries } from '../../../resource/plan'
import type { ProjectService } from '../../../../project'
import type { CreateResourcePlanner } from '../../../resource/plan'
import type { ValidatedCreateLineage } from '../../../resource/lineage'

type ResourceRow = CapsuleTables['capsuleBranchResources']['$inferSelect']

export interface CreateInventoryInspection {
  kind: 'absent' | 'complete' | 'inconsistent'
  untouched: boolean
  contradictions: string[]
}

/**
 * Reconstructs and validates create inventory from immutable create provenance.
 *
 * The recorded digest is evidence to verify, never a value to replace when
 * current planning rules no longer reproduce historical identities.
 */
export class CreateCapsuleInventoryPolicy {
  constructor(
    private readonly planner: CreateResourcePlanner,
    private readonly projects: ProjectService,
  ) {}

  public plan(lineage: ValidatedCreateLineage) {
    return this.planner.plan({
      namespace: this.projects.getNamespace(lineage.rootBranch.ownerId),
      rootBranchId: lineage.rootBranch.id,
      rootBranchName: lineage.extension.rootBranchName,
      cpu: lineage.extension.cpu,
      memory: lineage.extension.memory,
      blueprint: lineage.blueprint,
      rootfsImagePin: lineage.rootfsImagePin,
    })
  }

  public inspect(
    operationId: string,
    lineage: ValidatedCreateLineage,
    resources: readonly ResourceRow[],
  ): CreateInventoryInspection {
    const branch = lineage.rootBranch
    if (branch.resourceInventoryDigest === null && resources.length === 0) {
      return {
        kind: 'absent',
        untouched: true,
        contradictions: [],
      }
    }
    const contradictions: string[] = []
    if (branch.resourceInventoryDigest === null) {
      contradictions.push('resource_inventory_digest_missing')
    } else {
      try {
        const plan = this.plan(lineage)
        assertCapsuleBranchResourceInventoryMatches(
          branch.resourceInventoryDigest,
          createResourceInventoryEntries(plan),
        )
        assertCapsuleBranchResourceInventoryMatches(
          branch.resourceInventoryDigest,
          resources.map(resource => ({
            provider: resource.provider,
            resourceType: resource.resourceType,
            resourceKey: resource.resourceKey,
            blueprintVolumeName: resource.blueprintVolumeName,
            cleanupPolicy: resource.cleanupPolicy,
            metadata: resource.metadata,
          })),
        )
      } catch {
        contradictions.push('resource_inventory_does_not_match_immutable_plan')
      }
    }
    for (const resource of resources) {
      if (
        resource.ownerId !== branch.ownerId ||
        resource.branchId !== branch.id ||
        resource.branchName !== branch.name ||
        resource.createdByOperationId !== operationId ||
        resource.lastOperationId !== operationId ||
        resource.provider !== 'incus'
      ) {
        contradictions.push(`resource_attribution_mismatch:${resource.id}`)
      }
    }
    if (contradictions.length > 0) {
      return {
        kind: 'inconsistent',
        untouched: false,
        contradictions,
      }
    }
    return {
      kind: 'complete',
      untouched: resources.every(
        resource =>
          resource.status === CapsuleBranchResourceStatus.PLANNED &&
          resource.failureCode === null &&
          resource.failureMessage === null &&
          resource.failureDetails === null,
      ),
      contradictions: [],
    }
  }

  public assertComplete(
    operationId: string,
    lineage: ValidatedCreateLineage,
    resources: readonly ResourceRow[],
    requireUntouched = false,
  ): void {
    const inspection = this.inspect(operationId, lineage, resources)
    if (inspection.kind !== 'complete' || (requireUntouched && !inspection.untouched)) {
      throw new IncusError('Capsule create inventory does not satisfy its required durable evidence.', 'CONFLICT', {
        operationId,
        rootBranchId: lineage.rootBranch.id,
        inventoryState: inspection.kind,
        untouched: inspection.untouched,
        requireUntouched,
        contradictions: inspection.contradictions,
      })
    }
  }
}
