import { isTRPCClientError } from '@trpc/client'
import { render } from 'vike/abort'
import { z } from 'zod'
import { useTRPC } from '@/composables/useTRPC'
import type { CapsuleDetail } from '@qiln/core/client'
import type { PageContextClient, PageContextServer } from 'vike/types'

export type Data = {
  detail: CapsuleDetail
}

export async function data(pageContext: PageContextServer | PageContextClient): Promise<Data> {
  const capsuleId = z.uuid().safeParse(pageContext.routeParams?.capsuleId)
  if (!capsuleId.success) {
    throw render(404)
  }
  const trpc = useTRPC(pageContext)
  try {
    const detail = await trpc.engine.capsules.detail.query({
      capsuleId: capsuleId.data,
    })
    return {
      detail,
    }
  } catch (error: unknown) {
    if (isTRPCClientError(error) && error.data?.code === 'NOT_FOUND') {
      throw render(404)
    }
    throw error
  }
}
