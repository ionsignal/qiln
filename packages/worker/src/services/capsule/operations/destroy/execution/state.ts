import type { DestroyStepKey } from './steps'

/**
 * Process-local diagnostics never replace the persisted provider-intent fence.
 */
export class DestroyExecutionState {
  public phase: string = 'claim_operation'
  public step: DestroyStepKey | null = null
  public providerIntentConfirmed = false
  public completionConfirmed = false

  public enter(phase: string): void {
    this.phase = phase
    this.step = null
  }

  public begin(step: DestroyStepKey): void {
    this.phase = step
    this.step = step
  }
}
