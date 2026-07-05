import { t } from './init'
import { capsuleBranchRouter } from './routers/capsule/branch'
import { blueprintRouter } from './routers/blueprints'

export const engineRouter = t.router({
  status: t.procedure.query(() => {
    return { status: 'QilnEngine Capsule Channel Operational', version: '0.0.1' }
  }),
  capsules: t.router({
    branch: capsuleBranchRouter,
  }),
  blueprints: blueprintRouter,
})

export type EngineRouter = typeof engineRouter
export * from './utils'
