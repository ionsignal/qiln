import type { DestroyCapsuleFailurePhase } from './failureContext'
import type { DestroyCapsuleStepKey } from './stepKeys'

/**
 * Process-local diagnostic facts for one destroy attempt.
 *
 * This state has no serialization, recovery, replay, or resume behavior.
 * PostgreSQL remains authoritative for operation and aggregate state.
 *
 * In particular, `providerIntentCommitted` records only what this executor
 * observed. Terminal failure classification must reload the durable
 * `providerMutationStartedAt` fence because a database commit may have
 * succeeded even when its response did not reach this process.
 */
export class DestroyCapsuleExecutionState {
  private activeFailurePhase: DestroyCapsuleFailurePhase
  private activeStepKey: DestroyCapsuleStepKey | null = null
  private providerIntentFenceObserved = false
  private aggregateCompletionObserved = false

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
    this.providerIntentFenceObserved = true
  }

  public markAggregateCompletionCommitted(): void {
    this.aggregateCompletionObserved = true
  }

  public get currentFailurePhase(): DestroyCapsuleFailurePhase {
    return this.activeFailurePhase
  }

  public get currentStepKey(): DestroyCapsuleStepKey | null {
    return this.activeStepKey
  }

  public get providerIntentCommitted(): boolean {
    return this.providerIntentFenceObserved
  }

  public get completionCommitted(): boolean {
    return this.aggregateCompletionObserved
  }
}
