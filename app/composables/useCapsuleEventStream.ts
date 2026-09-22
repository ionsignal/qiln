import { onMounted, onUnmounted } from 'vue'
import { usePageContext } from '@/composables/usePageContext'
import { useTRPC } from '@/composables/useTRPC'
import type { CapsuleEventStreamSubscription } from '@qiln/engine/client'

type EventHandler = (event: unknown) => void

/**
 * Owns the Host subscription without giving Engine knowledge of Vike or the
 * application's top-level tRPC router.
 *
 * Initial connection and reconnection require authoritative reads because
 * capsule events are best-effort invalidations, not replayable state.
 */
export function useCapsuleEventStream(onConnected: () => Promise<void>) {
  const pageContext = usePageContext()
  const trpc = useTRPC(pageContext.value)
  const handlers = new Set<EventHandler>()
  let subscription: ReturnType<typeof trpc.stream.events.subscribe> | null = null
  let disposed = false

  function onEventStream(handler: EventHandler): CapsuleEventStreamSubscription {
    handlers.add(handler)
    return {
      unsubscribe: () => {
        handlers.delete(handler)
      },
    }
  }

  async function refreshAfterConnection(): Promise<void> {
    if (disposed) {
      return
    }
    try {
      await onConnected()
    } catch (error: unknown) {
      if (!disposed) {
        console.error('[Qiln Admin] Capsule state refresh after stream connection failed:', error)
      }
    }
  }

  onMounted(() => {
    subscription = trpc.stream.events.subscribe(undefined, {
      onStarted: () => {
        void refreshAfterConnection()
      },
      onData: event => {
        if (disposed) {
          return
        }
        for (const handler of handlers) {
          try {
            handler(event)
          } catch (error: unknown) {
            console.error('[Qiln Admin] Capsule event handler failed:', error)
          }
        }
      },
      onError: (error: unknown) => {
        if (!disposed) {
          console.error('[Qiln Admin] Capsule event stream error:', error)
        }
      },
    })
  })

  onUnmounted(() => {
    disposed = true
    subscription?.unsubscribe()
    subscription = null
    handlers.clear()
  })

  return {
    onEventStream,
  }
}
