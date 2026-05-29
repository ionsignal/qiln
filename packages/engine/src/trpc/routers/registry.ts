import { router, protectedProcedure } from '../init'
import { handleHostError } from '../utils'

export const registryRouter = router({
  /**
   * Fetches all parsed and validated application blueprints (AppDefinitions)
   * currently loaded in the host's memory cache.
   */
  list: protectedProcedure.query(({ ctx }) => {
    try {
      return ctx.host.registry.getAll()
    } catch (error: unknown) {
      handleHostError(error)
    }
  }),
})
