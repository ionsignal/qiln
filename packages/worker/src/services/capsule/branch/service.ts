import type { CapsuleCommandAck } from '@qiln/core/server'
import { createCapsuleBranchMutationResolutionError } from './resolution'
import type { CapsuleBranchEventPublisher } from '../events/branch'
import type { CapsuleBranchRuntimeObserver } from './observer'
import type { CapsuleBranchRuntimeReconciler } from './reconciler'
import type { CapsuleBranchStore } from '../stores'
import type { IncusClient } from '../../../incus/client/index'
import type { ProjectService } from '../../project'
import type { BranchRuntimeTransitionContext } from '../stores/types'
import type { BranchRuntimeMutation, BranchRuntimeMutationDefinition, StableBranchRuntimeStatus } from './types'

export interface CapsuleBranchRuntimeServiceDependencies {
  branches: CapsuleBranchStore
  events: CapsuleBranchEventPublisher
  observer: CapsuleBranchRuntimeObserver
  reconciler: CapsuleBranchRuntimeReconciler
  incus: IncusClient
  project: ProjectService
}

/**
 * Worker service for runtime behavior on existing editable capsule branches.
 *
 * Start and stop are exclusive, fail-closed mutations. Transitional statuses
 * are durable mutation fences, provider errors are followed by one observation,
 * and ambiguous outcomes become durable runtime errors instead of optimistic
 * rollbacks.
 *
 * Branch creation and branch-fork policy do not belong here. The capsule create
 * operation owns creation of the initial root branch, while a future branch-fork
 * operation will own creation from a committed snapshot.
 */
export class CapsuleBranchRuntimeService {
  constructor(private readonly dependencies: CapsuleBranchRuntimeServiceDependencies) {}

  /**
   * Fetches active editable branch runtimes for an owner.
   */
  public async list(ownerId: string) {
    return await this.dependencies.branches.listBranches(ownerId)
  }

  /**
   * Fetches one capsule branch and opportunistically enriches active runtime
   * state with a live Incus IPv4 address.
   *
   * This read path never persists its observation.
   */
  public async state(ownerId: string, capsuleId: string, name: string) {
    const branch = await this.dependencies.branches.findBranch(ownerId, capsuleId, name)
    if (!branch) {
      return null
    }
    if (branch.status !== 'online' && branch.status !== 'starting') {
      return branch
    }
    const observation = await this.dependencies.observer.observe(ownerId, branch.name)
    if (observation.kind !== 'confirmed' || observation.status !== 'online') {
      return branch
    }
    return {
      ...branch,
      runtimeIp: observation.runtimeIp ?? branch.runtimeIp,
    }
  }

  /**
   * Starts one existing offline branch of an active, unarchived capsule.
   */
  public async start(ownerId: string, capsuleId: string, name: string): Promise<CapsuleCommandAck> {
    const transition = await this.dependencies.branches.beginBranchStart(ownerId, capsuleId, name)
    return await this.executeRuntimeMutation(transition, {
      mutation: 'start',
      transitionalStatus: 'starting',
      desiredStatus: 'online',
      oppositeStatus: 'offline',
    })
  }

  /**
   * Stops one existing online branch of an active, unarchived capsule.
   *
   * A branch that is still starting cannot be stopped. Its existing provider
   * mutation must first reach a confirmed stable state or durable error state.
   */
  public async stop(ownerId: string, capsuleId: string, name: string): Promise<CapsuleCommandAck> {
    const transition = await this.dependencies.branches.beginBranchStop(ownerId, capsuleId, name)
    return await this.executeRuntimeMutation(transition, {
      mutation: 'stop',
      transitionalStatus: 'stopping',
      desiredStatus: 'offline',
      oppositeStatus: 'online',
    })
  }

  /**
   * Preserves the public branch-service API while delegating observation-only
   * startup reconciliation to its dedicated coordinator.
   */
  public async reconcileRuntimeStates(): Promise<void> {
    await this.dependencies.reconciler.reconcile()
  }

  private async executeRuntimeMutation(
    transition: BranchRuntimeTransitionContext,
    definition: BranchRuntimeMutationDefinition,
  ): Promise<CapsuleCommandAck> {
    this.dependencies.events.publishStateChanged(transition.ownerId, transition.capsuleId, transition.branchName, definition.transitionalStatus)
    try {
      await this.mutateProviderRuntime(transition, definition.mutation)
    } catch (providerError: unknown) {
      return await this.resolveMutationOutcome(transition, definition, providerError, 'provider_mutation_failed')
    }
    try {
      const result = await this.dependencies.branches.recordConfirmedRuntimeState({
        ownerId: transition.ownerId,
        capsuleId: transition.capsuleId,
        branchId: transition.branchId,
        expectedStatus: definition.transitionalStatus,
        confirmedStatus: definition.desiredStatus,
        runtimeIp: await this.readRuntimeIpAfterSuccessfulMutation(transition, definition.desiredStatus),
      })
      this.dependencies.events.publishCommittedState(transition.ownerId, transition.capsuleId, result)
      return {
        ok: true,
      }
    } catch (persistenceError: unknown) {
      return await this.resolveMutationOutcome(transition, definition, persistenceError, 'confirmed_state_persistence_failed')
    }
  }

  private async mutateProviderRuntime(transition: BranchRuntimeTransitionContext, mutation: BranchRuntimeMutation): Promise<void> {
    const namespace = this.dependencies.project.getNamespace(transition.ownerId)
    const project = this.dependencies.incus.UseProject(namespace)
    if (mutation === 'start') {
      await project.instances.start(transition.branchName)
      return
    }
    await project.instances.stop(transition.branchName)
  }

  private async readRuntimeIpAfterSuccessfulMutation(
    transition: BranchRuntimeTransitionContext,
    desiredStatus: StableBranchRuntimeStatus,
  ): Promise<string | null> {
    if (desiredStatus === 'offline') {
      return null
    }
    const observation = await this.dependencies.observer.observe(transition.ownerId, transition.branchName)
    if (observation.kind === 'confirmed' && observation.status === 'online') {
      return observation.runtimeIp
    }
    return null
  }

  private async resolveMutationOutcome(
    transition: BranchRuntimeTransitionContext,
    definition: BranchRuntimeMutationDefinition,
    mutationError: unknown,
    failureStage: string,
  ): Promise<CapsuleCommandAck> {
    const observation = await this.dependencies.observer.observe(transition.ownerId, transition.branchName)
    if (observation.kind === 'confirmed') {
      try {
        const result = await this.dependencies.branches.recordConfirmedRuntimeState({
          ownerId: transition.ownerId,
          capsuleId: transition.capsuleId,
          branchId: transition.branchId,
          expectedStatus: definition.transitionalStatus,
          confirmedStatus: observation.status,
          runtimeIp: observation.runtimeIp,
        })
        this.dependencies.events.publishCommittedState(transition.ownerId, transition.capsuleId, result)
      } catch (recoveryPersistenceError: unknown) {
        console.error(
          `[CapsuleBranchRuntimeService] Failed to persist observed '${observation.status}' state for capsule '${transition.capsuleId}' branch '${transition.branchName}'.`,
          {
            mutationError,
            recoveryPersistenceError,
          },
        )
        throw mutationError
      }
      if (observation.status === definition.desiredStatus) {
        return {
          ok: true,
        }
      }
      if (observation.status === definition.oppositeStatus) {
        throw mutationError
      }
    }
    const runtimeError = createCapsuleBranchMutationResolutionError(transition, definition, observation, mutationError, failureStage)
    try {
      const result = await this.dependencies.branches.recordRuntimeError({
        ownerId: transition.ownerId,
        capsuleId: transition.capsuleId,
        branchId: transition.branchId,
        expectedStatus: definition.transitionalStatus,
        error: runtimeError,
        context: runtimeError.details,
      })
      this.dependencies.events.publishCommittedState(transition.ownerId, transition.capsuleId, result)
    } catch (runtimeErrorPersistenceFailure: unknown) {
      console.error(
        `[CapsuleBranchRuntimeService] Failed to persist runtime uncertainty for capsule '${transition.capsuleId}' branch '${transition.branchName}'.`,
        {
          mutationError,
          runtimeError,
          runtimeErrorPersistenceFailure,
        },
      )
    }
    throw mutationError
  }
}
