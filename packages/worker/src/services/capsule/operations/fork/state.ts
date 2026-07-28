import type { ForkStep } from './steps'

export type ForkPhase = 'load' | 'claim' | 'intent' | 'complete' | 'classify' | ForkStep

/**
 * Process-local diagnostics for one fork execution.
 *
 * PostgreSQL remains authoritative. These values never authorize replay,
 * resumption, compensation, or terminal classification.
 */
export class ForkExecutionState {
  private phaseValue: ForkPhase = 'load'
  private stepValue: ForkStep | null = null
  private providerIntentObserved = false
  private finalizationStarted = false
  private completionObserved = false

  public step(step: ForkStep): void {
    this.phaseValue = step
    this.stepValue = step
  }

  public phase(phase: ForkPhase): void {
    this.phaseValue = phase
    this.stepValue = null
  }

  public providerIntent(): void {
    this.providerIntentObserved = true
  }

  public beginFinalization(): void {
    this.finalizationStarted = true
  }

  public completed(): void {
    this.completionObserved = true
  }

  public get currentPhase(): ForkPhase {
    return this.phaseValue
  }

  public get currentStep(): ForkStep | null {
    return this.stepValue
  }

  public get hasProviderIntent(): boolean {
    return this.providerIntentObserved
  }

  public get hasFinalizationStarted(): boolean {
    return this.finalizationStarted
  }

  public get hasCompleted(): boolean {
    return this.completionObserved
  }
}
