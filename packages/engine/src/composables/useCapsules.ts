import { onMounted, onUnmounted, provide, inject } from 'vue'
import { CapsuleBranchEventName, CapsuleEventSchema } from '@qiln/core/client'
import type { InjectionKey, Ref } from 'vue'
import type { TRPCClient } from '@trpc/client'
import type { HostRouter } from '../trpc'
import type { CapsuleBranchItem } from '../types'

export type CapsuleBranchClient = TRPCClient<HostRouter>['capsule']

export interface UseCapsulesOptions {
  client: CapsuleBranchClient
  branches: Ref<CapsuleBranchItem[]>
  onError?: (err: Error) => void
  onEventStream: (handler: (rawEvent: unknown) => void) => { unsubscribe: () => void }
}

export interface CapsuleContext {
  refresh: () => Promise<void>
  create: (name: string, blueprint?: string, cpu?: string, memory?: string) => Promise<void>
  start: (name: string) => Promise<void>
  stop: (name: string) => Promise<void>
  delete: (name: string) => Promise<void>
}

const CapsuleContextKey: InjectionKey<CapsuleContext> = Symbol('CapsuleContext')

export function provideCapsules(options: UseCapsulesOptions): CapsuleContext {
  async function refresh() {
    try {
      const list = await options.client.list.query()
      if (list) {
        options.branches.value = list
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error('Failed to refresh capsule branches')
      options.onError?.(error)
    }
  }

  async function create(name: string, blueprint?: string, cpu?: string, memory?: string) {
    await options.client.create.mutate({ name, blueprint, cpu, memory })
    await refresh()
  }

  async function start(name: string) {
    await options.client.start.mutate({ name })
  }

  async function stop(name: string) {
    await options.client.stop.mutate({ name })
  }

  async function remove(name: string) {
    try {
      await options.client.delete.mutate({ name })
      options.branches.value = options.branches.value.filter(branch => branch.name !== name)
    } catch (err: unknown) {
      await refresh().catch(error => console.error('[provideCapsules] Fallback refresh failed:', error))
      throw err
    }
  }

  onMounted(() => {
    const subscription = options.onEventStream((rawData: unknown) => {
      const parsedEvent = CapsuleEventSchema.safeParse(rawData)
      if (!parsedEvent.success) {
        return
      }

      const event = parsedEvent.data

      if (event.type === CapsuleBranchEventName.BRANCH_STATE_CHANGED) {
        const target = options.branches.value.find(branch => branch.name === event.name)
        if (target) {
          target.status = event.status
        } else {
          refresh().catch(error => console.error('[provideCapsules] Background refresh failed:', error))
        }
      } else if (event.type === CapsuleBranchEventName.BRANCH_DELETED) {
        options.branches.value = options.branches.value.filter(branch => branch.name !== event.name)
      }
    })

    onUnmounted(() => {
      subscription.unsubscribe()
    })
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
