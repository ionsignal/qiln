import { useTRPC } from '@/composables/useTRPC'
import type { PageContextServer, PageContextClient } from 'vike/types'
import type { CapsuleBlueprint } from '@qiln/core/client'
import type { CapsuleBranchItem } from '@qiln/engine/client'

export type Data = {
  branches: CapsuleBranchItem[]
  blueprints: CapsuleBlueprint[]
}

export async function data(pageContext: PageContextServer | PageContextClient): Promise<Data> {
  const trpc = useTRPC(pageContext)
  const [branches, blueprints] = await Promise.all([trpc.host.capsule.list.query(), trpc.host.registry.list.query()])

  return {
    branches: branches ?? [],
    blueprints: blueprints ?? [],
  }
}
