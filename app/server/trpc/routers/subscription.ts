import { CapsuleEventSchema } from '@qiln/core/server'
import { protectedProcedure, router } from '@server/trpc/procedures'
import type { AppEvent } from '@/types/events'

export const subscriptionRouter = router({
  events: protectedProcedure.subscription(async function* ({ ctx, signal }) {
    if (!signal) {
      throw new Error('[Subscription] Critical: AbortSignal is required to prevent memory leaks.')
    }

    try {
      for await (const event of ctx.host.events.subscribeForOwner(ctx.user.id, signal)) {
        const parsedEvent = CapsuleEventSchema.safeParse(event)
        if (!parsedEvent.success) {
          console.warn('[Subscription] Dropped capsule event that failed validation:', parsedEvent.error.issues)
          continue
        }

        yield parsedEvent.data satisfies AppEvent
      }
    } catch (error: unknown) {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        console.error('[Subscription] Error in capsule event stream:', error)
        throw error
      }
    }
  }),
})
