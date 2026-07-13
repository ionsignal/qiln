import type { CapsuleDestroyFailurePhase } from './failureContext'
import type { CapsuleDestroyStepKey } from './stepKeys'

/**
 * Ephemeral safety state for one inline capsule destroy execution.
 *
 * Durable operation, step, branch, and resource rows remain authoritative. This
 * state deliberately has no serialization, hydration, retry, skip, checkpoint,
 * or resume behavior.
 */
export class CapsuleDestroyExecutionState {
  private activeFailurePhase: CapsuleDestroyFailurePhase
  private activeStepKey: CapsuleDestroyStepKey | null = null
  private aggregateCommittedDestroyed = false

  constructor(initialPhase: CapsuleDestroyFailurePhase) {
    this.activeFailurePhase = initialPhase
  }

  public beginStep(stepKey: CapsuleDestroyStepKey): void {
    this.activeFailurePhase = stepKey
    this.activeStepKey = stepKey
  }

  public beginTerminalPhase(phase: CapsuleDestroyFailurePhase): void {
    this.activeFailurePhase = phase
    this.activeStepKey = null
  }

  public markAggregateDestroyed(): void {
    this.aggregateCommittedDestroyed = true
  }

  public get currentFailurePhase(): CapsuleDestroyFailurePhase {
    return this.activeFailurePhase
  }

  public get currentStepKey(): CapsuleDestroyStepKey | null {
    return this.activeStepKey
  }

  public get aggregateDestroyed(): boolean {
    return this.aggregateCommittedDestroyed
  }
}
