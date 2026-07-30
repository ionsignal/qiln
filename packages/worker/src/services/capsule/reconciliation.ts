import type { CapsuleBranchRuntimeService } from './branch'
import type { PreviewReconciliationCoordinator } from './routing/preview'

export interface CapsuleRuntimeReconciliationDependencies {
  branch: CapsuleBranchRuntimeService
  preview: PreviewReconciliationCoordinator
  intervalMs: number
}

/**
 * Owns ordered startup and periodic reconciliation for mutable runtime state.
 *
 * Each pass observes and persists branch runtime state before preview routing
 * reads branch eligibility. This coordinator is the sole timer owner for the
 * branch-to-preview reconciliation sequence.
 */
export class CapsuleRuntimeReconciliationCoordinator {
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<void> | null = null
  private stopped = false

  constructor(private readonly dependencies: CapsuleRuntimeReconciliationDependencies) {}

  public async reconcile(): Promise<void> {
    if (this.stopped) {
      return
    }
    if (this.running) {
      await this.running
      return
    }
    const execution = this.run()
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

  public start(): void {
    if (this.timer || this.stopped) {
      return
    }
    this.timer = setInterval(() => {
      void this.tick()
    }, this.dependencies.intervalMs)
    this.timer.unref()
  }

  public async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    await this.dependencies.preview.stop()
    if (this.running) {
      await this.running
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.running) {
      return
    }
    try {
      await this.reconcile()
    } catch (error: unknown) {
      console.warn('[CapsuleRuntimeReconciliationCoordinator] Periodic runtime reconciliation failed.', error)
    }
  }

  private async run(): Promise<void> {
    await this.dependencies.branch.reconcileRuntimeStates()
    await this.dependencies.preview.reconcile()
  }
}
