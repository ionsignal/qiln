import { router, protectedProcedure } from '../init'
import { handleEngineError } from '../utils'

export const registryRouter = router({
  /**
   * Fetches all parsed and validated application blueprints (AppDefinitions)
   * currently loaded in the engines's memory cache.
   */
  list: protectedProcedure.query(({ ctx }) => {
    try {
      return ctx.engine.registry.getAll()
    } catch (error: unknown) {
      handleEngineError(error)
    }
  }),
})
