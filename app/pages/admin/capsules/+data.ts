import { useTRPC } from '@/composables/useTRPC'
import type { PageContextClient, PageContextServer } from 'vike/types'
import type { CapsuleBlueprintManifest, CapsuleListOutput } from '@qiln/core/client'

export type Data = {
  capsules: CapsuleListOutput
  manifest: CapsuleBlueprintManifest
}

export async function data(pageContext: PageContextServer | PageContextClient): Promise<Data> {
  const trpc = useTRPC(pageContext)
  const [capsules, manifest] = await Promise.all([
    trpc.engine.capsules.list.query(),
    trpc.engine.blueprints.list.query(),
  ])
  return {
    capsules,
    manifest,
  }
}
