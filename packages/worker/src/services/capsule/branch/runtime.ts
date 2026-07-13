import { detailsFromUnknown } from '../stores/errorDetails'
import type { CapsuleBranchStatus, CapsuleCommandAck } from '@qiln/core/server'
import type { CapsuleBranchEventPublisher } from './events'
import type { CapsuleBranchRuntimeObservation, CapsuleBranchRuntimeObserver } from './providerState'
import type { CapsuleBranchStore } from '../stores'
import type { IncusClient } from '../../../incus/client/index'
import type { ProjectService } from '../../project'
import type { BranchRuntimeReconciliationCandidate, BranchRuntimeTransitionContext } from '../stores/types'

const RUNTIME_RESOLUTION_ERROR_CODE = 'CAPSULE_BRANCH_RUNTIME_UNCERTAIN'
const RUNTIME_INSTANCE_MISSING_ERROR_CODE = 'CAPSULE_BRANCH_RUNTIME_INSTANCE_MISSING'
const RUNTIME_PROVIDER_STATE_UNSUPPORTED_ERROR_CODE = 'CAPSULE_BRANCH_RUNTIME_PROVIDER_STATE_UNSUPPORTED'
const RUNTIME_OBSERVATION_UNAVAILABLE_ERROR_CODE = 'CAPSULE_BRANCH_RUNTIME_OBSERVATION_UNAVAILABLE'

type StableBranchRuntimeStatus = 'online' | 'offline'
type TransitionalBranchRuntimeStatus = 'starting' | 'stopping'
type RuntimeMutation = 'start' | 'stop'

interface BranchRuntimeMutationDefinition {
  mutation: RuntimeMutation
  transitionalStatus: TransitionalBranchRuntimeStatus
  desiredStatus: StableBranchRuntimeStatus
  oppositeStatus: StableBranchRuntimeStatus
}

class CapsuleBranchRuntimeResolutionError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'CapsuleBranchRuntimeResolutionError'
  }
}

export interface CapsuleBranchRuntimeDependencies {
  branches: CapsuleBranchStore
  events: CapsuleBranchEventPublisher
  incus: IncusClient
  project: ProjectService
  observer: CapsuleBranchRuntimeObserver
}

/**
 * Worker service for runtime mutations on existing editable capsule branches.
 *
 * Start and stop are exclusive, fail-closed mutations. Transitional statuses are
 * durable mutation fences, provider errors are followed by one observation, and
 * ambiguous outcomes become durable runtime errors instead of optimistic
 * rollbacks.
 */
export class CapsuleBranchRuntimeService {
  constructor(private readonly dependencies: CapsuleBranchRuntimeDependencies) {}

  /**
   * Fetches active editable branch runtimes for an owner.
   */
  public async list(ownerId: string) {
    return await this.dependencies.branches.listBranches(ownerId)
  }

  /**
   * Fetches one capsule branch and opportunistically enriches active runtime state with a live Incus IPv4 address.
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
   * A branch that is still starting cannot be stopped. Its existing provider mutation must first reach a confirmed stable state or durable error state.
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
   * Reconciles provider state into durable state without retrying any prior start or stop mutation.
   */
  public async reconcileRuntimeStates(): Promise<void> {
    const candidates = await this.dependencies.branches.listRuntimeReconciliationCandidates()
    if (candidates.length === 0) {
      return
    }
    console.log(`[CapsuleBranchRuntimeService] Reconciling ${candidates.length} capsule branch runtime(s).`)
    for (const candidate of candidates) {
      await this.reconcileRuntimeState(candidate)
    }
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
      this.publishConfirmedState(transition.ownerId, transition.capsuleId, result)
      return { ok: true }
    } catch (persistenceError: unknown) {
      return await this.resolveMutationOutcome(transition, definition, persistenceError, 'confirmed_state_persistence_failed')
    }
  }

  private async mutateProviderRuntime(transition: BranchRuntimeTransitionContext, mutation: RuntimeMutation): Promise<void> {
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
        this.publishConfirmedState(transition.ownerId, transition.capsuleId, result)
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
        return { ok: true }
      }
      if (observation.status === definition.oppositeStatus) {
        throw mutationError
      }
    }
    const runtimeError = this.createRuntimeResolutionError(transition, definition, observation, mutationError, failureStage)
    try {
      const result = await this.dependencies.branches.recordRuntimeError({
        ownerId: transition.ownerId,
        capsuleId: transition.capsuleId,
        branchId: transition.branchId,
        expectedStatus: definition.transitionalStatus,
        error: runtimeError,
        context: runtimeError.details,
      })

      if (result.statusChanged) {
        this.dependencies.events.publishStateChanged(transition.ownerId, transition.capsuleId, result.branchName, result.status)
      }
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

  private async reconcileRuntimeState(candidate: BranchRuntimeReconciliationCandidate): Promise<void> {
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
        this.publishConfirmedState(candidate.ownerId, candidate.capsuleId, result)
      } catch (error: unknown) {
        console.warn(
          `[CapsuleBranchRuntimeService] Could not persist reconciled '${observation.status}' state for capsule '${candidate.capsuleId}' branch '${candidate.name}'.`,
          error,
        )
      }

      return
    }
    if (observation.kind === 'unavailable' && this.isStableRuntimeStatus(candidate.status)) {
      console.warn(
        `[CapsuleBranchRuntimeService] Could not observe stable capsule '${candidate.capsuleId}' branch '${candidate.name}'. Preserving durable '${candidate.status}' state.`,
        observation.error,
      )
      return
    }
    const runtimeError = this.createReconciliationError(candidate, observation)
    try {
      const result = await this.dependencies.branches.recordRuntimeError({
        ownerId: candidate.ownerId,
        capsuleId: candidate.capsuleId,
        branchId: candidate.id,
        expectedStatus: candidate.status,
        error: runtimeError,
        context: runtimeError.details,
      })
      if (result.statusChanged) {
        this.dependencies.events.publishStateChanged(candidate.ownerId, candidate.capsuleId, result.branchName, 'error')
      }
    } catch (error: unknown) {
      console.warn(
        `[CapsuleBranchRuntimeService] Could not persist reconciled runtime uncertainty for capsule '${candidate.capsuleId}' branch '${candidate.name}'.`,
        error,
      )
    }
  }

  private createRuntimeResolutionError(
    transition: BranchRuntimeTransitionContext,
    definition: BranchRuntimeMutationDefinition,
    observation: CapsuleBranchRuntimeObservation,
    mutationError: unknown,
    failureStage: string,
  ): CapsuleBranchRuntimeResolutionError {
    return new CapsuleBranchRuntimeResolutionError(
      `Could not prove a stable runtime state after capsule branch ${definition.mutation}.`,
      RUNTIME_RESOLUTION_ERROR_CODE,
      {
        ownerId: transition.ownerId,
        capsuleId: transition.capsuleId,
        branchId: transition.branchId,
        branchName: transition.branchName,
        mutation: definition.mutation,
        failureStage,
        transitionalStatus: definition.transitionalStatus,
        desiredStatus: definition.desiredStatus,
        observation: this.describeObservation(observation),
        mutationError: detailsFromUnknown(mutationError) ?? {
          message: 'Unknown capsule branch runtime mutation failure.',
        },
      },
    )
  }

  private createReconciliationError(
    candidate: BranchRuntimeReconciliationCandidate,
    observation: Exclude<CapsuleBranchRuntimeObservation, { kind: 'confirmed' }>,
  ): CapsuleBranchRuntimeResolutionError {
    const description = this.describeObservation(observation)
    if (observation.kind === 'missing') {
      return new CapsuleBranchRuntimeResolutionError(
        'The managed Incus instance for this capsule branch is missing.',
        RUNTIME_INSTANCE_MISSING_ERROR_CODE,
        {
          ownerId: candidate.ownerId,
          capsuleId: candidate.capsuleId,
          branchId: candidate.id,
          branchName: candidate.name,
          previousStatus: candidate.status,
          reconciliation: true,
          observation: description,
        },
      )
    }

    if (observation.kind === 'unsupported') {
      return new CapsuleBranchRuntimeResolutionError(
        `The managed Incus instance is in unsupported provider state '${observation.providerStatus}'.`,
        RUNTIME_PROVIDER_STATE_UNSUPPORTED_ERROR_CODE,
        {
          ownerId: candidate.ownerId,
          capsuleId: candidate.capsuleId,
          branchId: candidate.id,
          branchName: candidate.name,
          previousStatus: candidate.status,
          reconciliation: true,
          observation: description,
        },
      )
    }

    return new CapsuleBranchRuntimeResolutionError(
      'The Worker could not observe the capsule branch provider state.',
      RUNTIME_OBSERVATION_UNAVAILABLE_ERROR_CODE,
      {
        ownerId: candidate.ownerId,
        capsuleId: candidate.capsuleId,
        branchId: candidate.id,
        branchName: candidate.name,
        previousStatus: candidate.status,
        reconciliation: true,
        observation: description,
      },
    )
  }

  private describeObservation(observation: CapsuleBranchRuntimeObservation): Record<string, unknown> {
    switch (observation.kind) {
      case 'confirmed':
        return {
          kind: observation.kind,
          status: observation.status,
          providerStatus: observation.providerStatus,
          runtimeIp: observation.runtimeIp,
        }
      case 'missing':
        return {
          kind: observation.kind,
        }
      case 'unsupported':
        return {
          kind: observation.kind,
          providerStatus: observation.providerStatus,
        }
      case 'unavailable':
        return {
          kind: observation.kind,
          error: detailsFromUnknown(observation.error) ?? {
            message: 'Unknown provider observation failure.',
          },
        }
    }
  }

  private publishConfirmedState(
    ownerId: string,
    capsuleId: string,
    result: {
      branchName: string
      status: StableBranchRuntimeStatus
      statusChanged: boolean
    },
  ): void {
    if (!result.statusChanged) {
      return
    }
    this.dependencies.events.publishStateChanged(ownerId, capsuleId, result.branchName, result.status)
  }

  private isStableRuntimeStatus(status: CapsuleBranchStatus): status is StableBranchRuntimeStatus {
    return status === 'online' || status === 'offline'
  }
}
