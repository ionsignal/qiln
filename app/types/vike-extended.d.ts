import type { GlobalContext } from 'vike/types'
import type { Component } from 'vue'
import type { TRPCClient } from '@trpc/client'
import type { AppRouter } from '@server/trpc'
import type { AuthenticatedUser } from '@/types/entities'

// https://vike.dev/meta#typescript
declare global {
  namespace Vike {
    interface Config {
      Layout?: Component | Component[]
      title?: string | ((pageContext: PageContext) => string)
      description?: string | ((pageContext: PageContext) => string)
    }
    // Shared Context (Client & Server)
    interface PageContext {
      Page: Component
      data: unknown
      user: AuthenticatedUser | null
      pageProps?: unknown
      config: {
        title?: string | ((pageContext: PageContext) => string)
        description?: string | ((pageContext: PageContext) => string)
        Layout?: Component
      }
      urlPathname?: string
      redirectTo?: string | null
      routeParams?: Record<string, string>
      is404: boolean | null
      abortReason?: unknown
    }
    // Server-Side Context
    interface PageContextServer {
      trpc: TRPCClient<AppRouter>
    }
    // Server-Side Initialization Context
    interface PageContextInit {
      trpc: TRPCClient<AppRouter>
      user: AuthenticatedUser | null
    }
  }
}
