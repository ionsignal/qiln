import { t } from './init'
import { capsuleRouter } from './routers/capsule'
import { registryRouter } from './routers/registry'

export const hostRouter = t.router({
  status: t.procedure.query(() => {
    return { status: 'QilnEngine Capsule Channel Operational', version: '0.0.1' }
  }),
  capsule: capsuleRouter,
  registry: registryRouter,
})

export type HostRouter = typeof hostRouter
export * from './utils'
