import { inject, onMounted, onUnmounted, provide } from 'vue'
import {
  CapsuleBranchEventName,
  CapsuleEventSchema,
  CapsuleLifecycleEventName,
  type CapsuleBlueprintDigest,
  type CapsuleBranchName,
  type CapsuleBranchStatus,
  type CapsuleLifecycleIdempotencyKey,
} from '@qiln/core/client'
import type { InjectionKey, Ref } from 'vue'
import type { TRPCClient } from '@trpc/client'
import type { EngineRouter } from '../trpc'
import type { CapsuleBranchItem } from '../types'

export type CapsuleClient = TRPCClient<EngineRouter>['capsules']

export interface CapsuleEventStreamSubscription {
  unsubscribe: () => void
}

export interface CapsuleBranchRuntimeInput {
  capsuleId: string
  name: CapsuleBranchName
}

export interface CapsuleCreateClientInput {
  rootBranchName: CapsuleBranchName
  blueprintName: string
  blueprintDigest: CapsuleBlueprintDigest
  idempotencyKey: CapsuleLifecycleIdempotencyKey
  cpu?: string
  memory?: string
}

export interface ProvideCapsulesOptions {
  client: CapsuleClient
  branches: Ref<CapsuleBranchItem[]>
  onError?: (error: Error) => void
  onEventStream: (handler: (rawEvent: unknown) => void) => CapsuleEventStreamSubscription
}

export interface CapsuleContext {
  refreshBranches: () => Promise<void>
  createCapsule: (input: CapsuleCreateClientInput) => Promise<void>
  startBranch: (input: CapsuleBranchRuntimeInput) => Promise<void>
  stopBranch: (input: CapsuleBranchRuntimeInput) => Promise<void>
}

const CapsuleContextKey: InjectionKey<CapsuleContext> = Symbol('CapsuleContext')

function toError(error: unknown, fallbackMessage: string): Error {
  return error instanceof Error ? error : new Error(fallbackMessage)
}

function branchIdentityMatches(branch: CapsuleBranchItem, input: CapsuleBranchRuntimeInput): boolean {
  return branch.capsuleId === input.capsuleId && branch.name === input.name
}

export function provideCapsules(options: ProvideCapsulesOptions): CapsuleContext {
  let eventSubscription: CapsuleEventStreamSubscription | null = null
  function findBranch(input: CapsuleBranchRuntimeInput): CapsuleBranchItem | undefined {
    return options.branches.value.find(branch => branchIdentityMatches(branch, input))
  }

  function replaceBranch(input: CapsuleBranchRuntimeInput, update: (branch: CapsuleBranchItem) => CapsuleBranchItem): boolean {
    let replaced = false
    options.branches.value = options.branches.value.map(branch => {
      if (!branchIdentityMatches(branch, input)) {
        return branch
      }
      replaced = true
      return update(branch)
    })
    return replaced
  }

  function setLocalBranchStatus(input: CapsuleBranchRuntimeInput, status: CapsuleBranchStatus): boolean {
    return replaceBranch(input, branch => ({
      ...branch,
      status,
    }))
  }

  async function fetchBranches(): Promise<void> {
    const branches = await options.client.branches.list.query()
    options.branches.value = branches
  }

  async function refreshBranchesSafely(): Promise<boolean> {
    try {
      await fetchBranches()
      return true
    } catch (error: unknown) {
      options.onError?.(toError(error, 'Failed to refresh capsule branches'))
      return false
    }
  }

  async function refreshBranches(): Promise<void> {
    await fetchBranches()
  }

  function refreshFromCapsuleEvent(): void {
    void refreshBranchesSafely().then(refreshed => {
      if (!refreshed) {
        console.error('[provideCapsules] Background refresh failed after a capsule event.')
      }
    })
  }

  async function runRuntimeMutation(
    input: CapsuleBranchRuntimeInput,
    pendingStatus: CapsuleBranchStatus,
    successStatus: CapsuleBranchStatus,
    mutate: () => Promise<unknown>,
  ): Promise<void> {
    const previousStatus = findBranch(input)?.status
    setLocalBranchStatus(input, pendingStatus)
    try {
      await mutate()
      setLocalBranchStatus(input, successStatus)
      await refreshBranchesSafely()
    } catch (error: unknown) {
      const refreshed = await refreshBranchesSafely()
      if (!refreshed && previousStatus) {
        setLocalBranchStatus(input, previousStatus)
      }
      throw error
    }
  }

  async function createCapsule(input: CapsuleCreateClientInput): Promise<void> {
    await options.client.create.mutate(input)
    await refreshBranches()
  }

  async function startBranch(input: CapsuleBranchRuntimeInput): Promise<void> {
    await runRuntimeMutation(input, 'starting', 'online', () => options.client.branches.start.mutate(input))
  }

  async function stopBranch(input: CapsuleBranchRuntimeInput): Promise<void> {
    await runRuntimeMutation(input, 'stopping', 'offline', () => options.client.branches.stop.mutate(input))
  }

  onMounted(() => {
    eventSubscription = options.onEventStream((rawEvent: unknown) => {
      const parsedEvent = CapsuleEventSchema.safeParse(rawEvent)
      if (!parsedEvent.success) {
        return
      }
      const event = parsedEvent.data
      if (event.type === CapsuleBranchEventName.BRANCH_STATE_CHANGED || event.type === CapsuleLifecycleEventName.LIFECYCLE_CHANGED) {
        refreshFromCapsuleEvent()
      }
    })
  })

  onUnmounted(() => {
    eventSubscription?.unsubscribe()
    eventSubscription = null
  })

  const context: CapsuleContext = {
    refreshBranches,
    createCapsule,
    startBranch,
    stopBranch,
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
