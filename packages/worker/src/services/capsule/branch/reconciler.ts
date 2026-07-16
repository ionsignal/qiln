import type { CapsuleBranchStatus } from '@qiln/core/server'
import { createCapsuleBranchReconciliationError } from './resolution'
import type { CapsuleBranchEventPublisher } from '../events/branch'
import type { CapsuleBranchRuntimeObserver } from './observer'
import type { CapsuleBranchStore } from '../stores'
import type { BranchRuntimeReconciliationCandidate } from '../stores/types'
import type { StableBranchRuntimeStatus } from './types'

export interface CapsuleBranchRuntimeReconcilerDependencies {
  branches: CapsuleBranchStore
  events: CapsuleBranchEventPublisher
  observer: CapsuleBranchRuntimeObserver
}

/**
 * Reconciles live provider observations into durable branch runtime state.
 *
 * Reconciliation is strictly observation-only. It never starts, stops,
 * retries, deletes, adopts, or otherwise mutates provider resources.
 */
export class CapsuleBranchRuntimeReconciler {
  constructor(private readonly dependencies: CapsuleBranchRuntimeReconcilerDependencies) {}

  /**
   * Reconciles provider state without retrying any prior start or stop mutation.
   *
   * Candidates are processed serially so startup does not create an unbounded
   * provider-read burst and the resulting diagnostics remain easy to follow.
   */
  public async reconcile(): Promise<void> {
    const candidates = await this.dependencies.branches.listRuntimeReconciliationCandidates()
    if (candidates.length === 0) {
      return
    }
    console.log(`[CapsuleBranchRuntimeReconciler] Reconciling ${candidates.length} capsule branch runtime(s).`)
    for (const candidate of candidates) {
      await this.reconcileCandidate(candidate)
    }
  }

  private async reconcileCandidate(candidate: BranchRuntimeReconciliationCandidate): Promise<void> {
    const observation = await this.dependencies.observer.observe(candidate.ownerId, candidate.name)
    if (observation.kind === 'confirmed') {
      try {
        const result = await this.dependencies.branches.recordConfirmedRuntimeState({
          ownerId: candidate.ownerId,
          capsuleId: candidate.capsuleId,
          branchId: candidate.id,
          expectedStatus: candidate.status,
          confirmedStatus: observation.status,
          runtimeIp: observation.runtimeIp,
        })
        this.dependencies.events.publishCommittedState(candidate.ownerId, candidate.capsuleId, result)
      } catch (error: unknown) {
        console.warn(
          `[CapsuleBranchRuntimeReconciler] Could not persist reconciled '${observation.status}' state for capsule '${candidate.capsuleId}' branch '${candidate.name}'.`,
          error,
        )
      }
      return
    }
    if (observation.kind === 'unavailable' && this.isStableRuntimeStatus(candidate.status)) {
      console.warn(
        `[CapsuleBranchRuntimeReconciler] Could not observe stable capsule '${candidate.capsuleId}' branch '${candidate.name}'. Preserving durable '${candidate.status}' state.`,
        observation.error,
      )
      return
    }
    const runtimeError = createCapsuleBranchReconciliationError(candidate, observation)
    try {
      const result = await this.dependencies.branches.recordRuntimeError({
        ownerId: candidate.ownerId,
        capsuleId: candidate.capsuleId,
        branchId: candidate.id,
        expectedStatus: candidate.status,
        error: runtimeError,
        context: runtimeError.details,
      })
      this.dependencies.events.publishCommittedState(candidate.ownerId, candidate.capsuleId, result)
    } catch (error: unknown) {
      console.warn(
        `[CapsuleBranchRuntimeReconciler] Could not persist reconciled runtime uncertainty for capsule '${candidate.capsuleId}' branch '${candidate.name}'.`,
        error,
      )
    }
  }

  private isStableRuntimeStatus(status: CapsuleBranchStatus): status is StableBranchRuntimeStatus {
    return status === 'online' || status === 'offline'
  }
}
