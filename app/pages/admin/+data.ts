import { useTRPC } from '@/composables/useTRPC'
import type { PageContextServer, PageContextClient } from 'vike/types'
import type { HostInstanceItem, AppDefinition } from '@qiln/engine/client'

export type Data = {
  instances: HostInstanceItem[]
  blueprints: AppDefinition[]
}

export async function data(pageContext: PageContextServer | PageContextClient): Promise<Data> {
  const trpc = useTRPC(pageContext)
  const [instances, blueprints] = await Promise.all([trpc.host.instance.list.query(), trpc.host.registry.list.query()])
  return {
    instances: instances ?? [],
    blueprints: blueprints ?? [],
  }
}
