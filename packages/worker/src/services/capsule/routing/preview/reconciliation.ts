import type { PreviewRouteController } from './controller'
import type { PreviewRepository } from './persistence'
import type { PreviewRecord } from './types'

export interface PreviewReconciliationDependencies {
  repository: PreviewRepository
  controller: PreviewRouteController
}

/**
 * Serializes preview reconciliation and explicit branch withdrawal/resume
 * requests within one Worker process.
 *
 * Timer ownership belongs to the capsule runtime reconciliation coordinator so
 * every periodic preview pass is preceded by branch runtime reconciliation.
 */
export class PreviewReconciliationCoordinator {
  private running: Promise<void> | null = null
  private stopped = false

  constructor(private readonly dependencies: PreviewReconciliationDependencies) {}

  public async reconcile(): Promise<void> {
    if (this.stopped) {
      return
    }
    await this.exclusive(async () => {
      const [branches, previews] = await Promise.all([
        this.dependencies.repository.branches(),
        this.dependencies.repository.all(),
      ])
      const previewsByBranch = this.group(previews)
      for (const branch of branches) {
        await this.dependencies.controller.reconcile(branch, previewsByBranch.get(branch.id) ?? [])
      }
    })
  }

  public async withdraw(ownerId: string, capsuleId: string, branchId: string): Promise<void> {
    await this.exclusive(async () => {
      const previews = await this.dependencies.repository.withdraw(ownerId, capsuleId, branchId)
      for (const preview of previews) {
        await this.dependencies.controller.withdraw(preview)
      }
    })
  }

  public async resume(ownerId: string, capsuleId: string, branchId: string): Promise<void> {
    await this.exclusive(async () => {
      await this.dependencies.repository.resume(ownerId, capsuleId, branchId)
    })
  }

  public async stop(): Promise<void> {
    this.stopped = true
    if (this.running) {
      await this.running
    }
  }

  private group(previews: readonly PreviewRecord[]): Map<string, PreviewRecord[]> {
    const grouped = new Map<string, PreviewRecord[]>()
    for (const preview of previews) {
      const branchPreviews = grouped.get(preview.branchId) ?? []
      branchPreviews.push(preview)
      grouped.set(preview.branchId, branchPreviews)
    }
    return grouped
  }

  private async exclusive(action: () => Promise<void>): Promise<void> {
    while (this.running) {
      await this.running
    }
    if (this.stopped) {
      return
    }
    const execution = Promise.resolve().then(action)
    const completion = execution.then(
      () => undefined,
      () => undefined,
    )
    this.running = completion
    try {
      await execution
    } finally {
      if (this.running === completion) {
        this.running = null
      }
    }
  }
}
