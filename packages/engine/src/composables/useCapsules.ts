import { inject, onMounted, onUnmounted, provide } from 'vue'
import {
  CapsuleBranchEventName,
  CapsuleEventSchema,
  CapsuleLifecycleEventName,
  CapsuleOperationEventName,
  type CapsuleArchiveReceipt,
  type CapsuleBlueprintDigest,
  type CapsuleBranchName,
  type CapsuleBranchStatus,
  type CapsuleCreateReceipt,
  type CapsuleDestroyReceipt,
  type CapsuleEvent,
  type CapsuleOperationIdempotencyKey,
  type CapsuleUnarchiveReceipt,
} from '@qiln/core/client'
import type { InjectionKey, Ref } from 'vue'
import type { TRPCClient } from '@trpc/client'
import type { EngineRouter } from '../trpc'
import type { CapsuleBranchSummary, CapsuleOperationSummary } from '../types'

export type CapsuleClient = TRPCClient<EngineRouter>['capsules']

export interface CapsuleEventStreamSubscription {
  unsubscribe: () => void
}

export interface CapsuleBranchInput {
  capsuleId: string
  name: CapsuleBranchName
}

export interface CapsuleCreateClientInput {
  rootBranchName: CapsuleBranchName
  blueprintName: string
  blueprintDigest: CapsuleBlueprintDigest
  idempotencyKey: CapsuleOperationIdempotencyKey
  cpu?: string
  memory?: string
}

/**
 * Shared input for capsule-level archive, unarchive, and destroy mutations.
 *
 * Callers own idempotency-key generation so a retry of the same user intent can
 * reuse the same key rather than accidentally submitting a second operation.
 */
export interface CapsuleMutationInput {
  capsuleId: string
  idempotencyKey: CapsuleOperationIdempotencyKey
}

export interface ProvideCapsulesOptions {
  client: CapsuleClient
  branches: Ref<CapsuleBranchSummary[]>
  onError?: (error: Error) => void
  onEventStream: (handler: (rawEvent: unknown) => void) => CapsuleEventStreamSubscription
}

export interface CapsuleContext {
  refreshBranches: () => Promise<void>

  createCapsule: (input: CapsuleCreateClientInput) => Promise<CapsuleCreateReceipt>
  archive: (input: CapsuleMutationInput) => Promise<CapsuleArchiveReceipt>
  unarchive: (input: CapsuleMutationInput) => Promise<CapsuleUnarchiveReceipt>
  destroy: (input: CapsuleMutationInput) => Promise<CapsuleDestroyReceipt>

  startBranch: (input: CapsuleBranchInput) => Promise<void>
  stopBranch: (input: CapsuleBranchInput) => Promise<void>

  getOperation: (operationId: string) => Promise<CapsuleOperationSummary>
  listOperations: (capsuleId: string) => Promise<CapsuleOperationSummary[]>
}

const CapsuleContextKey: InjectionKey<CapsuleContext> = Symbol('CapsuleContext')

function toError(error: unknown, fallbackMessage: string): Error {
  return error instanceof Error ? error : new Error(fallbackMessage)
}

function branchIdentityMatches(branch: CapsuleBranchSummary, input: CapsuleBranchInput): boolean {
  return branch.capsuleId === input.capsuleId && branch.name === input.name
}

/**
 * Capsule events are invalidation hints rather than an authoritative state
 * stream. Consumers refetch PostgreSQL-backed branch state after receiving
 * one.
 */
function invalidatesBranchCollection(event: CapsuleEvent): boolean {
  return (
    event.type === CapsuleBranchEventName.BRANCH_STATE_CHANGED ||
    event.type === CapsuleLifecycleEventName.LIFECYCLE_CHANGED ||
    event.type === CapsuleOperationEventName.OPERATION_CHANGED
  )
}

export function provideCapsules(options: ProvideCapsulesOptions): CapsuleContext {
  let eventSubscription: CapsuleEventStreamSubscription | null = null
  let eventStreamActive = false

  let eventRefreshPending = false
  let eventRefreshScheduled = false
  let eventRefreshInProgress = false

  // ---------------------------------------------------------------------------
  // Branch collection
  // ---------------------------------------------------------------------------

  function findBranch(input: CapsuleBranchInput): CapsuleBranchSummary | undefined {
    return options.branches.value.find(branch => branchIdentityMatches(branch, input))
  }

  function updateBranch(
    input: CapsuleBranchInput,
    update: (branch: CapsuleBranchSummary) => CapsuleBranchSummary,
  ): boolean {
    let updated = false
    options.branches.value = options.branches.value.map(branch => {
      if (!branchIdentityMatches(branch, input)) {
        return branch
      }
      updated = true
      return update(branch)
    })
    return updated
  }

  function setLocalBranchStatus(input: CapsuleBranchInput, status: CapsuleBranchStatus): boolean {
    return updateBranch(input, branch => ({
      ...branch,
      status,
    }))
  }

  async function refreshBranches(): Promise<void> {
    options.branches.value = await options.client.branches.list.query()
  }

  async function refreshBranchesSafely(): Promise<boolean> {
    try {
      await refreshBranches()
      return true
    } catch (error: unknown) {
      reportBackgroundError(error, 'Failed to refresh capsule branches.')
      return false
    }
  }

  function reportBackgroundError(error: unknown, fallbackMessage: string): void {
    const normalizedError = toError(error, fallbackMessage)
    if (!options.onError) {
      console.error('[provideCapsules] Background capsule synchronization failed.', normalizedError)
      return
    }
    try {
      options.onError(normalizedError)
    } catch (handlerError: unknown) {
      console.error('[provideCapsules] Capsule error handler failed.', handlerError)
    }
  }

  // ---------------------------------------------------------------------------
  // Event-driven invalidation refresh
  // ---------------------------------------------------------------------------

  /**
   * Coalesces synchronous event bursts into one branch refresh.
   *
   * If another event arrives while a refresh is running, one additional pass is
   * requested so state committed during the active query is still observed.
   */
  function scheduleEventDrivenRefresh(): void {
    if (!eventStreamActive) {
      return
    }
    eventRefreshPending = true
    if (eventRefreshScheduled || eventRefreshInProgress) {
      return
    }
    eventRefreshScheduled = true
    queueMicrotask(() => {
      eventRefreshScheduled = false
      if (!eventStreamActive) {
        eventRefreshPending = false
        return
      }
      void processEventDrivenRefreshes()
    })
  }

  async function processEventDrivenRefreshes(): Promise<void> {
    if (eventRefreshInProgress) {
      return
    }
    eventRefreshInProgress = true
    try {
      while (eventStreamActive && eventRefreshPending) {
        eventRefreshPending = false
        await refreshBranchesSafely()
      }
    } finally {
      eventRefreshInProgress = false

      if (eventStreamActive && eventRefreshPending) {
        scheduleEventDrivenRefresh()
      }
    }
  }

  function handleCapsuleEvent(rawEvent: unknown): void {
    const parsedEvent = CapsuleEventSchema.safeParse(rawEvent)
    if (!parsedEvent.success) {
      return
    }
    if (invalidatesBranchCollection(parsedEvent.data)) {
      scheduleEventDrivenRefresh()
    }
  }

  // ---------------------------------------------------------------------------
  // Capsule lifecycle mutations
  // ---------------------------------------------------------------------------

  /**
   * A durable mutation receipt must not be converted into a client-visible
   * mutation failure merely because the follow-up branch refresh failed.
   */
  async function submitCapsuleMutation<TResult>(submit: () => Promise<TResult>): Promise<TResult> {
    const result = await submit()
    await refreshBranchesSafely()
    return result
  }

  async function createCapsule(input: CapsuleCreateClientInput): Promise<CapsuleCreateReceipt> {
    return await submitCapsuleMutation(() => options.client.create.mutate(input))
  }

  async function archive(input: CapsuleMutationInput): Promise<CapsuleArchiveReceipt> {
    return await submitCapsuleMutation(() => options.client.archive.mutate(input))
  }

  async function unarchive(input: CapsuleMutationInput): Promise<CapsuleUnarchiveReceipt> {
    return await submitCapsuleMutation(() => options.client.unarchive.mutate(input))
  }

  async function destroy(input: CapsuleMutationInput): Promise<CapsuleDestroyReceipt> {
    return await submitCapsuleMutation(() => options.client.destroy.mutate(input))
  }

  // ---------------------------------------------------------------------------
  // Branch runtime mutations
  // ---------------------------------------------------------------------------

  async function runBranchRuntimeMutation(
    input: CapsuleBranchInput,
    pendingStatus: CapsuleBranchStatus,
    completedStatus: CapsuleBranchStatus,
    mutate: () => Promise<unknown>,
  ): Promise<void> {
    const previousStatus = findBranch(input)?.status

    setLocalBranchStatus(input, pendingStatus)

    try {
      await mutate()
      setLocalBranchStatus(input, completedStatus)
      await refreshBranchesSafely()
    } catch (error: unknown) {
      const refreshed = await refreshBranchesSafely()
      if (!refreshed && previousStatus) {
        setLocalBranchStatus(input, previousStatus)
      }
      throw error
    }
  }

  async function startBranch(input: CapsuleBranchInput): Promise<void> {
    await runBranchRuntimeMutation(input, 'starting', 'online', () => options.client.branches.start.mutate(input))
  }

  async function stopBranch(input: CapsuleBranchInput): Promise<void> {
    await runBranchRuntimeMutation(input, 'stopping', 'offline', () => options.client.branches.stop.mutate(input))
  }

  // ---------------------------------------------------------------------------
  // Durable operation history
  // ---------------------------------------------------------------------------

  async function getOperation(operationId: string): Promise<CapsuleOperationSummary> {
    return await options.client.operations.get.query({
      operationId,
    })
  }

  async function listOperations(capsuleId: string): Promise<CapsuleOperationSummary[]> {
    return await options.client.operations.list.query({
      capsuleId,
    })
  }

  // ---------------------------------------------------------------------------
  // Event subscription lifecycle
  // ---------------------------------------------------------------------------

  onMounted(() => {
    eventStreamActive = true
    try {
      eventSubscription = options.onEventStream(handleCapsuleEvent)
    } catch (error: unknown) {
      eventStreamActive = false
      reportBackgroundError(error, 'Failed to subscribe to capsule events.')
    }
  })

  onUnmounted(() => {
    eventStreamActive = false
    eventRefreshPending = false
    eventRefreshScheduled = false
    eventSubscription?.unsubscribe()
    eventSubscription = null
  })

  const context: CapsuleContext = {
    refreshBranches,

    createCapsule,
    archive,
    unarchive,
    destroy,

    startBranch,
    stopBranch,

    getOperation,
    listOperations,
  }
  provide(CapsuleContextKey, context)
  return context
}

export function useCapsuleContext(): CapsuleContext {
  const context = inject(CapsuleContextKey)
  if (!context) {
    throw new Error('[qiln-engine] useCapsuleContext must be used inside a component tree that calls provideCapsules()')
  }
  return context
}
