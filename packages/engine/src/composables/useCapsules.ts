import { onMounted, onUnmounted, provide, inject } from 'vue'
import {
  CapsuleBranchEventName,
  CapsuleEventSchema,
  type CapsuleBlueprintDigest,
  type CapsuleBranchIdempotencyKey,
  type CapsuleBranchName,
  type CapsuleBranchStatus,
} from '@qiln/core/client'
import type { InjectionKey, Ref } from 'vue'
import type { TRPCClient } from '@trpc/client'
import type { EngineRouter } from '../trpc'
import type { CapsuleBranchItem } from '../types'

export type CapsuleBranchClient = TRPCClient<EngineRouter>['capsules']

export interface CapsuleEventStreamSubscription {
  unsubscribe: () => void
}

export interface CapsuleBranchDeleteClientInput {
  name: CapsuleBranchName
  idempotencyKey: CapsuleBranchIdempotencyKey
}

export interface CapsuleBranchCreateClientInput {
  name: CapsuleBranchName
  blueprintName: string
  blueprintDigest: CapsuleBlueprintDigest
  idempotencyKey: CapsuleBranchIdempotencyKey
  cpu?: string
  memory?: string
}

export interface UseCapsulesOptions {
  client: CapsuleBranchClient
  branches: Ref<CapsuleBranchItem[]>
  onError?: (err: Error) => void
  onEventStream: (handler: (rawEvent: unknown) => void) => CapsuleEventStreamSubscription
}

export interface CapsuleContext {
  refresh: () => Promise<void>
  create: (input: CapsuleBranchCreateClientInput) => Promise<void>
  delete: (input: CapsuleBranchDeleteClientInput) => Promise<void>
  start: (name: string) => Promise<void>
  stop: (name: string) => Promise<void>
}

const CapsuleContextKey: InjectionKey<CapsuleContext> = Symbol('CapsuleContext')

function toError(err: unknown, fallbackMessage: string): Error {
  return err instanceof Error ? err : new Error(fallbackMessage)
}

export function provideCapsules(options: UseCapsulesOptions): CapsuleContext {
  let eventSubscription: CapsuleEventStreamSubscription | null = null

  function findBranch(name: string): CapsuleBranchItem | undefined {
    return options.branches.value.find(branch => branch.name === name)
  }

  function replaceBranch(name: string, update: (branch: CapsuleBranchItem) => CapsuleBranchItem): boolean {
    let replaced = false
    options.branches.value = options.branches.value.map(branch => {
      if (branch.name !== name) {
        return branch
      }
      replaced = true
      return update(branch)
    })
    return replaced
  }

  function setLocalBranchStatus(name: string, status: CapsuleBranchStatus): boolean {
    return replaceBranch(name, branch => ({
      ...branch,
      status,
    }))
  }

  async function refreshBranches(): Promise<void> {
    const list = await options.client.branch.list.query()
    options.branches.value = list ?? []
  }

  async function refreshSafely(): Promise<boolean> {
    try {
      await refreshBranches()
      return true
    } catch (err: unknown) {
      options.onError?.(toError(err, 'Failed to refresh capsule branches'))
      return false
    }
  }

  async function refresh() {
    await refreshSafely()
  }

  function refreshFromCapsuleEvent(): void {
    void refreshSafely().then(refreshed => {
      if (!refreshed) {
        console.error('[provideCapsules] Background refresh failed after a capsule branch event.')
      }
    })
  }

  async function runLifecycleMutation(
    name: string,
    pendingStatus: CapsuleBranchStatus,
    successStatus: CapsuleBranchStatus,
    mutate: () => Promise<unknown>,
  ): Promise<void> {
    const previousStatus = findBranch(name)?.status
    setLocalBranchStatus(name, pendingStatus)
    try {
      await mutate()
      setLocalBranchStatus(name, successStatus)
      await refreshSafely()
    } catch (err: unknown) {
      const refreshed = await refreshSafely()
      if (!refreshed && previousStatus) {
        setLocalBranchStatus(name, previousStatus)
      }
      throw err
    }
  }

  async function create(input: CapsuleBranchCreateClientInput) {
    await options.client.branch.create.mutate(input)
    await refresh()
  }

  async function start(name: string) {
    await runLifecycleMutation(name, 'starting', 'online', () => options.client.branch.start.mutate({ name }))
  }

  async function stop(name: string) {
    await runLifecycleMutation(name, 'stopping', 'offline', () => options.client.branch.stop.mutate({ name }))
  }

  async function remove(input: CapsuleBranchDeleteClientInput) {
    try {
      await options.client.branch.delete.mutate(input)
      options.branches.value = options.branches.value.filter(branch => branch.name !== input.name)
    } catch (err: unknown) {
      await refreshSafely()
      throw err
    }
  }

  onMounted(() => {
    eventSubscription = options.onEventStream((rawData: unknown) => {
      const parsedEvent = CapsuleEventSchema.safeParse(rawData)
      if (!parsedEvent.success) {
        return
      }
      const event = parsedEvent.data
      if (event.type === CapsuleBranchEventName.BRANCH_STATE_CHANGED || event.type === CapsuleBranchEventName.BRANCH_DELETED) {
        refreshFromCapsuleEvent()
      }
    })
  })

  onUnmounted(() => {
    eventSubscription?.unsubscribe()
    eventSubscription = null
  })

  const context: CapsuleContext = {
    refresh,
    create,
    start,
    stop,
    delete: remove,
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
