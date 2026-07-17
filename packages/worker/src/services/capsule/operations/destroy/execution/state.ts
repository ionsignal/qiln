import type { DestroyOperationPhase } from './diagnostics'
import type { DestroyStepKey } from './steps'

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
export class DestroyExecutionState {
  private activePhase: DestroyOperationPhase
  private activeStepKey: DestroyStepKey | null = null
  private providerIntentFenceObserved = false
  private aggregateCompletionObserved = false

  constructor(initialPhase: DestroyOperationPhase) {
    this.activePhase = initialPhase
  }

  public beginStep(stepKey: DestroyStepKey): void {
    this.activePhase = stepKey
    this.activeStepKey = stepKey
  }

  public enterPhase(phase: DestroyOperationPhase): void {
    this.activePhase = phase
    this.activeStepKey = null
  }

  public markProviderIntentCommitted(): void {
    this.providerIntentFenceObserved = true
  }

  public markAggregateCompletionCommitted(): void {
    this.aggregateCompletionObserved = true
  }

  public get currentPhase(): DestroyOperationPhase {
    return this.activePhase
  }

  public get currentStepKey(): DestroyStepKey | null {
    return this.activeStepKey
  }

  public get providerIntentCommitted(): boolean {
    return this.providerIntentFenceObserved
  }

  public get completionCommitted(): boolean {
    return this.aggregateCompletionObserved
  }
}
