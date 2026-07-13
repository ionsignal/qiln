import { createCapsuleBranchResourceInventoryDigest } from '../../resources/inventory'
import type { CapsuleBranchResourceInventoryEntry } from '../../resources/inventory'
import type { CapsuleBranchStore } from '../../stores'
import type { BootstrapResourcePlanner } from '../planner'
import type { BootstrapResourcePlan, BootstrapResourcePlanInput } from '../types'

function createExpectedResourceInventoryEntries(plan: BootstrapResourcePlan): CapsuleBranchResourceInventoryEntry[] {
  return [plan.project, ...plan.bindMounts, ...plan.volumes, plan.instance, ...plan.files].map(resource => ({
    provider: 'incus',
    resourceType: resource.resourceType,
    resourceKey: resource.resourceKey,
    cleanupPolicy: resource.cleanupPolicy,
    metadata: resource.metadata,
  }))
}

/**
 * Performs deterministic bootstrap planning and records the immutable identity digest for the complete planned resource inventory.
 *
 * The coordinator decides when these methods run and wraps them in their stable
 * durable operation steps.
 */
export class BootstrapPreparationPhase {
  constructor(
    private readonly planner: BootstrapResourcePlanner,
    private readonly branches: CapsuleBranchStore,
  ) {}

  public createResourcePlan(input: BootstrapResourcePlanInput): BootstrapResourcePlan {
    return this.planner.createPlan(input)
  }

  public async recordResourceInventory(ownerId: string, branchId: string, plan: BootstrapResourcePlan): Promise<void> {
    const resourceInventoryDigest = createCapsuleBranchResourceInventoryDigest(
      createExpectedResourceInventoryEntries(plan),
      'capsule bootstrap planned resource inventory',
    )
    await this.branches.recordBootstrapBranchResourceInventoryDigest(ownerId, branchId, resourceInventoryDigest)
  }
}
