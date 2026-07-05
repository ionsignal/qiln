import { useTRPC } from '@/composables/useTRPC'
import type { PageContextServer, PageContextClient } from 'vike/types'
import type { CapsuleBlueprintManifest } from '@qiln/core/client'
import type { CapsuleBranchItem } from '@qiln/engine/client'

export type Data = {
  branches: CapsuleBranchItem[]
  manifest: CapsuleBlueprintManifest
}

export async function data(pageContext: PageContextServer | PageContextClient): Promise<Data> {
  const trpc = useTRPC(pageContext)
  const [branches, manifest] = await Promise.all([trpc.engine.capsules.branch.list.query(), trpc.engine.blueprints.list.query()])
  return {
    branches,
    manifest,
  }
}
