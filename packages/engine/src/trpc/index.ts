import { t } from './init'
import { instanceRouter } from './routers/instance'
import { registryRouter } from './routers/registry'

export const hostRouter = t.router({
  status: t.procedure.query(() => {
    return { status: 'QilnEngine Infrastructure Operational', version: '0.0.1' }
  }),
  instance: instanceRouter,
  registry: registryRouter,
})

export type HostRouter = typeof hostRouter
export * from './utils'
