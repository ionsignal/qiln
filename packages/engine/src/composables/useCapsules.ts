import { inject, onMounted, onUnmounted, provide, readonly, ref } from 'vue'
import {
  CapsuleEventSchema,
  type CapsuleArchiveReceipt,
  type CapsuleBlueprintDigest,
  type CapsuleBranchStartReceipt,
  type CapsuleBranchStopReceipt,
  type CapsuleCreateReceipt,
  type CapsuleDestroyReceipt,
  type CapsuleEvent,
  type CapsuleOperationIdempotencyKey,
  type CapsuleUnarchiveReceipt,
} from '@qiln/core/client'
import type { InjectionKey, Ref } from 'vue'
import type { TRPCClient } from '@trpc/client'
import type { EngineRouter } from '../trpc'
import type { CapsuleBranchSummary, CapsuleOperationSummary, CapsuleSnapshotSummary } from '../types'

export type CapsuleClient = TRPCClient<EngineRouter>['capsules']

export interface CapsuleEventStreamSubscription {
  unsubscribe: () => void
}

export interface CapsuleBranchMutationInput {
  capsuleId: string
  branchId: string
  idempotencyKey: CapsuleOperationIdempotencyKey
}

/**
 * @deprecated Use CapsuleBranchMutationInput instead.
 */
export type CapsuleBranchInput = CapsuleBranchMutationInput

export interface CapsuleCreateClientInput {
  rootBranchName: string
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

interface CapsuleProviderOptions {
  client: CapsuleClient
  onError?: (error: Error) => void
  onEventStream: (handler: (rawEvent: unknown) => void) => CapsuleEventStreamSubscription

  /**
   * Omit for an owner-wide index. Detail callers should read their current
   * capsule identity inside this predicate rather than capture an initial ID.
   */
  isEventRelevant?: (event: CapsuleEvent) => boolean
}

export interface CapsuleRefreshOptions extends CapsuleProviderOptions {
  /**
   * Fetches and installs authoritative state for the currently selected scope.
   *
   * Hosts own navigation and must discard responses for obsolete route scopes.
   * This callback must not call the returned context's refresh method.
   */
  refresh: () => Promise<void>
  branches?: never
}

/**
 * @deprecated Supply refresh instead when migrating to capsule-first reads.
 *
 *   Retained so the existing operational branch index remains runnable until its
 *   Host integration is migrated.
 */
export interface CapsuleBranchProviderOptions extends CapsuleProviderOptions {
  branches: Ref<CapsuleBranchSummary[]>
  refresh?: never
}

export type ProvideCapsulesOptions = CapsuleRefreshOptions | CapsuleBranchProviderOptions

export interface CapsuleContext {
  refresh: () => Promise<void>
  refreshing: Readonly<Ref<boolean>>
  refreshError: Readonly<Ref<Error | null>>

  /**
   * @deprecated Use refresh for the provider's current scope.
   *
   *   Supported only by legacy branch-backed providers. This method never
   *   silently substitutes a capsule index or detail read for a branch read.
   */
  refreshBranches: () => Promise<void>

  createCapsule: (input: CapsuleCreateClientInput) => Promise<CapsuleCreateReceipt>
  archive: (input: CapsuleMutationInput) => Promise<CapsuleArchiveReceipt>
  unarchive: (input: CapsuleMutationInput) => Promise<CapsuleUnarchiveReceipt>
  destroy: (input: CapsuleMutationInput) => Promise<CapsuleDestroyReceipt>

  startBranch: (input: CapsuleBranchMutationInput) => Promise<CapsuleBranchStartReceipt>
  stopBranch: (input: CapsuleBranchMutationInput) => Promise<CapsuleBranchStopReceipt>

  getOperation: (operationId: string) => Promise<CapsuleOperationSummary>
  listOperations: (capsuleId: string) => Promise<CapsuleOperationSummary[]>

  listSnapshots: (capsuleId: string) => Promise<CapsuleSnapshotSummary[]>
}

const CapsuleContextKey: InjectionKey<CapsuleContext> = Symbol('CapsuleContext')

function toError(error: unknown, fallbackMessage: string): Error {
  return error instanceof Error ? error : new Error(fallbackMessage)
}

/**
 * Capsule events are invalidation hints rather than an authoritative state
 * stream. Consumers refetch authoritative state after receiving one.
 *
 * Every validated capsule event can invalidate the owner-wide index, including
 * preview and route changes. A Host predicate narrows detail-page refreshes.
 */
export function provideCapsules(options: ProvideCapsulesOptions): CapsuleContext {
  const refreshing = ref(false)
  const refreshError = ref<Error | null>(null)
  const legacyBranches = options.branches

  if (legacyBranches !== undefined && options.refresh !== undefined) {
    throw new Error('[qiln-engine] provideCapsules accepts either branches or refresh, not both.')
  }

  const refreshCandidate =
    options.refresh ??
    (legacyBranches === undefined
      ? undefined
      : async () => {
          const branches = await options.client.branches.list.query()
          if (!disposed) {
            legacyBranches.value = branches
          }
        })
  if (refreshCandidate === undefined) {
    throw new Error('[qiln-engine] provideCapsules requires a refresh callback or legacy branches ref.')
  }
  const refreshState: () => Promise<void> = refreshCandidate

  let disposed = false
  let eventSubscription: CapsuleEventStreamSubscription | null = null
  let eventStreamActive = false
  let eventRefreshScheduled = false
  let refreshPending = false
  let refreshTask: Promise<void> | null = null

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

  /**
   * Serializes refreshes from mutations, events, and explicit Host requests.
   *
   * Requests arriving during a read cause one further pass. This prevents an
   * older read from racing a mutation refresh and observes changes committed
   * while the current query was running.
   */
  function refresh(): Promise<void> {
    if (disposed) {
      return Promise.resolve()
    }
    refreshPending = true
    if (refreshTask !== null) {
      return refreshTask
    }
    refreshing.value = true
    refreshTask = Promise.resolve()
      .then(async () => {
        let lastError: Error | null = null
        while (!disposed && refreshPending) {
          refreshPending = false
          try {
            await refreshState()
            lastError = null
            if (!disposed) {
              refreshError.value = null
            }
          } catch (error: unknown) {
            lastError = toError(error, 'Failed to refresh capsule state.')
            if (!disposed) {
              refreshError.value = lastError
            }
          }
        }
        if (!disposed && lastError !== null) {
          throw lastError
        }
      })
      .finally(() => {
        refreshing.value = false
        refreshTask = null
      })
    return refreshTask
  }

  async function refreshSafely(): Promise<void> {
    try {
      await refresh()
    } catch (error: unknown) {
      reportBackgroundError(error, 'Failed to refresh capsule state.')
    }
  }

  async function refreshBranches(): Promise<void> {
    if (legacyBranches === undefined) {
      throw new Error(
        '[qiln-engine] refreshBranches requires a legacy branch-backed provider. Use refresh for capsule state.',
      )
    }
    await refresh()
  }

  /**
   * Coalesces synchronous event bursts before requesting a refresh.
   *
   * If another event arrives while a refresh is running, refresh() requests an
   * additional pass rather than starting an overlapping query.
   */
  function scheduleEventRefresh(): void {
    if (!eventStreamActive || eventRefreshScheduled) {
      return
    }
    eventRefreshScheduled = true
    queueMicrotask(() => {
      eventRefreshScheduled = false
      if (eventStreamActive && !disposed) {
        void refreshSafely()
      }
    })
  }

  function handleCapsuleEvent(rawEvent: unknown): void {
    const parsedEvent = CapsuleEventSchema.safeParse(rawEvent)
    if (!parsedEvent.success) {
      return
    }
    try {
      if (options.isEventRelevant && !options.isEventRelevant(parsedEvent.data)) {
        return
      }
    } catch (error: unknown) {
      reportBackgroundError(error, 'Failed to determine capsule event relevance.')
      return
    }
    scheduleEventRefresh()
  }

  // ---------------------------------------------------------------------------
  // Capsule lifecycle mutations
  // ---------------------------------------------------------------------------

  /**
   * A durable mutation receipt must not be converted into a client-visible
   * mutation failure merely because the follow-up refresh failed.
   */
  async function submitAndRefresh<TResult>(submit: () => Promise<TResult>): Promise<TResult> {
    const result = await submit()
    await refreshSafely()
    return result
  }

  async function createCapsule(input: CapsuleCreateClientInput): Promise<CapsuleCreateReceipt> {
    return await submitAndRefresh(() => options.client.create.mutate(input))
  }

  async function archive(input: CapsuleMutationInput): Promise<CapsuleArchiveReceipt> {
    return await submitAndRefresh(() => options.client.archive.mutate(input))
  }

  async function unarchive(input: CapsuleMutationInput): Promise<CapsuleUnarchiveReceipt> {
    return await submitAndRefresh(() => options.client.unarchive.mutate(input))
  }

  async function destroy(input: CapsuleMutationInput): Promise<CapsuleDestroyReceipt> {
    return await submitAndRefresh(() => options.client.destroy.mutate(input))
  }

  // ---------------------------------------------------------------------------
  // Branch runtime mutations
  // ---------------------------------------------------------------------------

  async function startBranch(input: CapsuleBranchMutationInput): Promise<CapsuleBranchStartReceipt> {
    return await submitAndRefresh(() => options.client.branches.start.mutate(input))
  }

  async function stopBranch(input: CapsuleBranchMutationInput): Promise<CapsuleBranchStopReceipt> {
    return await submitAndRefresh(() => options.client.branches.stop.mutate(input))
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
  // Committed snapshot history
  // ---------------------------------------------------------------------------

  /**
   * Fetches client-safe committed snapshot summaries.
   *
   * This method exposes no capture mutation and no detailed manifest, Git,
   * dependency, provider-reference, or capture-operation evidence.
   */
  async function listSnapshots(capsuleId: string): Promise<CapsuleSnapshotSummary[]> {
    return await options.client.snapshots.list.query({
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
    disposed = true
    eventStreamActive = false
    refreshPending = false
    eventRefreshScheduled = false
    eventSubscription?.unsubscribe()
    eventSubscription = null
  })

  const context: CapsuleContext = {
    refresh,
    refreshing: readonly(refreshing),
    refreshError: readonly(refreshError),
    refreshBranches,

    createCapsule,

    archive,
    unarchive,
    destroy,

    startBranch,
    stopBranch,

    getOperation,

    listOperations,
    listSnapshots,
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
