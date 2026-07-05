import { z } from 'zod'
import { CapsuleBlueprintSchema } from '@qiln/core/server'
import { router, protectedProcedure } from '../init'
import { handleEngineError } from '../utils'

export const blueprintRouter = router({
  /**
   * Fetches all parsed and validated capsule blueprints currently loaded in the
   * engine's in-memory registry.
   */
  list: protectedProcedure.output(z.array(CapsuleBlueprintSchema)).query(({ ctx }) => {
    try {
      return ctx.engine.blueprints.list()
    } catch (error: unknown) {
      handleEngineError(error)
    }
  }),
})
