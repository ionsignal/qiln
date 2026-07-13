import { t } from './init'
import { blueprintRouter } from './routers/blueprints'
import { capsuleRouter } from './routers/capsule'

export const engineRouter = t.router({
  status: t.procedure.query(() => {
    return {
      status: 'QilnEngine Capsule Channel Operational',
      version: '0.0.1',
    }
  }),
  capsules: capsuleRouter,
  blueprints: blueprintRouter,
})

export type EngineRouter = typeof engineRouter

export * from './utils'
