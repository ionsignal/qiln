import type { CapsuleBranchRuntimeObserver } from './observer'
import type { CapsuleBranchRuntimeReconciler } from './reconciler'
import type { CapsuleBranchStore } from './store'

export interface CapsuleBranchRuntimeServiceDependencies {
  branches: CapsuleBranchStore
  observer: CapsuleBranchRuntimeObserver
  reconciler: CapsuleBranchRuntimeReconciler
}

/**
 * Read and observation-only reconciliation service for editable capsule
 * branches.
 */
export class CapsuleBranchRuntimeService {
  constructor(private readonly dependencies: CapsuleBranchRuntimeServiceDependencies) {}

  public async list(ownerId: string) {
    return await this.dependencies.branches.listBranches(ownerId)
  }

  /**
   * Fetches one branch and opportunistically enriches an active runtime with a
   * live Incus IPv4 address.
   */
  public async state(ownerId: string, capsuleId: string, name: string) {
    const branch = await this.dependencies.branches.findBranch(ownerId, capsuleId, name)
    if (!branch) {
      return null
    }
    if (branch.status !== 'online' && branch.status !== 'starting') {
      return branch
    }
    const observation = await this.dependencies.observer.observe(ownerId, branch.id)
    if (observation.kind !== 'confirmed' || observation.status !== 'online') {
      return branch
    }
    return {
      ...branch,
      runtimeIp: observation.runtimeIp ?? branch.runtimeIp,
    }
  }

  public async reconcileRuntimeStates(): Promise<void> {
    await this.dependencies.reconciler.reconcile()
  }
}
