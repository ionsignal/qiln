import type { CapsuleBranchPreviewListOutput } from '@qiln/core/server'
import type { PreviewReconciliationCoordinator } from './reconciliation'
import type { PreviewRepository } from './persistence'

export interface PreviewServiceDependencies {
  repository: PreviewRepository
  reconciliation: PreviewReconciliationCoordinator
}

/**
 * Narrow public capability for editable branch previews.
 *
 * Durable state transitions belong to preview persistence. Caddy orchestration
 * belongs to the route controller. Process-local serialization belongs to the
 * preview reconciliation coordinator.
 */
export class PreviewService {
  constructor(private readonly dependencies: PreviewServiceDependencies) {}

  public async list(ownerId: string, capsuleId: string): Promise<CapsuleBranchPreviewListOutput> {
    return await this.dependencies.repository.list(ownerId, capsuleId)
  }

  public async withdrawBranch(ownerId: string, capsuleId: string, branchId: string): Promise<void> {
    await this.dependencies.reconciliation.withdraw(ownerId, capsuleId, branchId)
  }

  public async resumeBranch(ownerId: string, capsuleId: string, branchId: string): Promise<void> {
    await this.dependencies.reconciliation.resume(ownerId, capsuleId, branchId)
  }

  public async reconcile(): Promise<void> {
    await this.dependencies.reconciliation.reconcile()
  }
}
