import type { DestroyCapsuleFailurePhase } from './failureContext'
import type { DestroyCapsuleStepKey } from './stepKeys'

/**
 * Process-local safety facts for one destroy attempt.
 *
 * This state has no serialization, recovery, replay, or resume behavior.
 * PostgreSQL remains authoritative for operation and aggregate state.
 */
export class DestroyCapsuleExecutionState {
  private activeFailurePhase: DestroyCapsuleFailurePhase
  private activeStepKey: DestroyCapsuleStepKey | null = null
  private providerIntentFenceCommitted = false
  private aggregateCompletionCommitted = false

  constructor(initialPhase: DestroyCapsuleFailurePhase) {
    this.activeFailurePhase = initialPhase
  }

  public beginStep(stepKey: DestroyCapsuleStepKey): void {
    this.activeFailurePhase = stepKey
    this.activeStepKey = stepKey
  }

  public beginTerminalPhase(phase: DestroyCapsuleFailurePhase): void {
    this.activeFailurePhase = phase
    this.activeStepKey = null
  }

  public markProviderIntentCommitted(): void {
    this.providerIntentFenceCommitted = true
  }

  public markAggregateCompletionCommitted(): void {
    this.aggregateCompletionCommitted = true
  }

  public get currentFailurePhase(): DestroyCapsuleFailurePhase {
    return this.activeFailurePhase
  }

  public get currentStepKey(): DestroyCapsuleStepKey | null {
    return this.activeStepKey
  }

  public get providerIntentCommitted(): boolean {
    return this.providerIntentFenceCommitted
  }

  public get completionCommitted(): boolean {
    return this.aggregateCompletionCommitted
  }
}
