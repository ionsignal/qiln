import { trpc } from '@/renderer/api/trpc'
import type { PageContextServer, PageContextClient } from 'vike/types'

/**
 * A unified tRPC hook that abstracts the execution environment.
 *
 * @param pageContext The Vike pageContext object
 * @returns A strictly typed tRPC client compatible with both environments.
 */
export function useTRPC(pageContext: PageContextServer | PageContextClient): typeof trpc {
  if (import.meta.env.SSR) {
    return (pageContext as PageContextServer).trpc as typeof trpc
  }
  return trpc
}
