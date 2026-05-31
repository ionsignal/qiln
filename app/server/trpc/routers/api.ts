import { publicProcedure, router } from '@server/trpc/procedures'

export const apiRouter = router({
  version: publicProcedure.query(() => {
    return { version: '0.0.1' }
  }),
})
