import { useTRPC } from '@/composables/useTRPC'
import type { PageContextClient, PageContextServer } from 'vike/types'
import type { CapsuleBlueprintManifest } from '@qiln/core/client'
import type { CapsuleBranchSummary } from '@qiln/engine/client'

export type Data = {
  branches: CapsuleBranchSummary[]
  manifest: CapsuleBlueprintManifest
}

export async function data(pageContext: PageContextServer | PageContextClient): Promise<Data> {
  const trpc = useTRPC(pageContext)
  const [branches, manifest] = await Promise.all([trpc.engine.capsules.branches.list.query(), trpc.engine.blueprints.list.query()])
  return {
    branches,
    manifest,
  }
}
