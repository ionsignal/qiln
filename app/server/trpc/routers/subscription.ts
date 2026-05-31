import { protectedProcedure, router } from '@server/trpc/procedures'
import type { DispatcherEnvelope, AppEvent } from '@/types/events'

const MAX_QUEUE_SIZE = 500

export const subscriptionRouter = router({
  events: protectedProcedure.subscription(async function* ({ ctx, signal }) {
    if (!signal) {
      throw new Error('[Subscription] Critical: AbortSignal is required to prevent memory leaks.')
    }
    const userId = ctx.user.id
    const queue: AppEvent[] = []
    let resolveNext: (() => void) | null = null
    const pushEvent = (rawEnvelope: unknown) => {
      if (!rawEnvelope || typeof rawEnvelope !== 'object' || !('event' in rawEnvelope) || !(rawEnvelope as any).event) {
        console.warn('[Subscription] Dropped malformed event emitted to dispatcher:', rawEnvelope)
        return
      }
      const envelope = rawEnvelope as DispatcherEnvelope
      if (queue.length >= MAX_QUEUE_SIZE) {
        queue.shift()
        console.warn(`[Subscription] Queue for user ${userId} exceeded ${MAX_QUEUE_SIZE}. Dropping oldest event.`)
      }
      queue.push(envelope.event as AppEvent)
      if (resolveNext) {
        resolveNext()
        resolveNext = null
      }
    }
    // Subscribe to both targeted user events and global broadcasts
    ctx.dispatcher.on('event:broadcast', pushEvent)
    ctx.dispatcher.on(`event:user:${userId}`, pushEvent)
    const onAbort = () => {
      if (resolveNext) {
        resolveNext()
        resolveNext = null
      }
    }
    signal.addEventListener('abort', onAbort)
    try {
      while (true) {
        if (signal.aborted) break
        if (queue.length > 0) {
          // Yield the strictly typed AppEvent union to the frontend
          yield queue.shift()!
        } else {
          await new Promise<void>(resolve => {
            resolveNext = resolve
          })
        }
      }
    } catch (error) {
      console.error('[Subscription] Error in event stream:', error)
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
      ctx.dispatcher.off('event:broadcast', pushEvent)
      ctx.dispatcher.off(`event:user:${userId}`, pushEvent)
    }
  }),
})
