import { onMounted, onUnmounted, provide, inject } from 'vue'
import { HostEventSchema, HostEventType } from '../schemas'
import type { InjectionKey, Ref } from 'vue'
import type { TRPCClient } from '@trpc/client'
import type { HostRouter } from '../trpc'
import type { HostInstanceItem } from '../types'

export type HostInstanceClient = TRPCClient<HostRouter>['instance']

export interface UseInstancesOptions {
  client: HostInstanceClient
  instances: Ref<HostInstanceItem[]>
  onError?: (err: Error) => void
  onEventStream: (handler: (rawEvent: unknown) => void) => { unsubscribe: () => void }
}

export interface InstanceContext {
  refresh: () => Promise<void>
  create: (name: string, definition?: string, cpu?: string, memory?: string) => Promise<void>
  start: (name: string) => Promise<void>
  stop: (name: string) => Promise<void>
  delete: (name: string) => Promise<void>
}

const InstanceContextKey: InjectionKey<InstanceContext> = Symbol('InstanceContext')

export function provideInstances(options: UseInstancesOptions): InstanceContext {
  async function refresh() {
    try {
      const list = await options.client.list.query()
      if (list) {
        options.instances.value = list
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to refresh instances')
      options.onError?.(error)
    }
  }

  async function create(name: string, definition?: string, cpu?: string, memory?: string) {
    try {
      await options.client.create.mutate({ name, definition, cpu, memory })
      await refresh()
    } catch (err) {
      throw err
    }
  }

  async function start(name: string) {
    try {
      await options.client.start.mutate({ name })
    } catch (err) {
      throw err
    }
  }

  async function stop(name: string) {
    try {
      await options.client.stop.mutate({ name })
    } catch (err) {
      throw err
    }
  }

  async function remove(name: string) {
    try {
      await options.client.delete.mutate({ name })
      options.instances.value = options.instances.value.filter(i => i.name !== name)
    } catch (err) {
      await refresh().catch(e => console.error('[provideInstances] Fallback refresh failed:', e))
      throw err
    }
  }

  onMounted(() => {
    const subscription = options.onEventStream((rawData: unknown) => {
      const parsedEvent = HostEventSchema.safeParse(rawData)
      if (!parsedEvent.success) return
      const event = parsedEvent.data
      if (event.type === HostEventType.INSTANCE_STATE) {
        const target = options.instances.value.find(i => i.name === event.instance)
        if (target) {
          target.status = event.status
        } else {
          refresh().catch(e => console.error('[provideInstances] Background refresh failed:', e))
        }
      } else if (event.type === HostEventType.INSTANCE_DELETED) {
        options.instances.value = options.instances.value.filter(i => i.name !== event.instance)
      }
    })

    onUnmounted(() => {
      subscription.unsubscribe()
    })
  })

  const context: InstanceContext = {
    refresh,
    create,
    start,
    stop,
    delete: remove,
  }

  provide(InstanceContextKey, context)

  return context
}

export function useInstanceContext(): InstanceContext {
  const context = inject(InstanceContextKey)
  if (!context) {
    throw new Error('[qiln-engine] useInstanceContext must be used inside a component tree that calls provideInstances()')
  }
  return context
}
