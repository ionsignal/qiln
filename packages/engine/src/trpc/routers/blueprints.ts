import { CapsuleBlueprintManifestSchema } from '@qiln/core/server'
import { router, protectedProcedure } from '../init'
import { handleEngineError } from '../utils'

export const blueprintRouter = router({
  /**
   * Fetches the worker-authoritative capsule blueprint manifest.
   */
  list: protectedProcedure.output(CapsuleBlueprintManifestSchema).query(async ({ ctx }) => {
    try {
      return await ctx.engine.blueprints.list()
    } catch (error: unknown) {
      handleEngineError(error)
    }
  }),
})
