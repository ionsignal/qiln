import superjson from 'superjson'
import { createTRPCProxyClient, httpBatchLink, splitLink, createWSClient, wsLink } from '@trpc/client'
import type { TRPCLink } from '@trpc/client'
import type { AppRouter } from '@server/trpc'

const transformer = superjson

/**
 * robustly determines the HTTP URL based on environment.
 * - Dev: Points to the separate backend port (3002).
 * - Prod: Uses relative path (served by Fastify).
 */
const getHttpUrl = () => {
  return import.meta.env.DEV ? 'http://localhost:3002/trpc' : '/trpc'
}

/**
 * Factory function to construct the tRPC link chain.
 * Isolates browser-specific logic (WebSockets) from server-side logic (SSR).
 */
function getLinks(): TRPCLink<AppRouter>[] {
  // Server-Side: HTTP Only (No WebSocket support needed/possible)
  if (typeof window === 'undefined') {
    return [
      httpBatchLink({
        url: getHttpUrl(),
        transformer,
        fetch: () => {
          throw new Error(
            '[api/trpc.ts] You are using the client-side tRPC instance on the server. ' +
              'Please use `pageContext.trpc` instead to avoid network overhead and relative URL errors.',
          )
        },
      }),
    ]
  }
  // Client-Side: Split Link (WebSocket + HTTP)
  // Dynamic protocol detection handles both HTTP/HTTPS environments automatically
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = import.meta.env.DEV ? 'localhost:3002' : window.location.host
  const wsClient = createWSClient({
    url: `${protocol}//${host}/trpc`,
    lazy: {
      enabled: true,
      closeMs: 5000,
    },
    keepAlive: {
      enabled: true,
      intervalMs: 30000,
      pongTimeoutMs: 5000,
    },
  })
  return [
    splitLink({
      // Route subscriptions to WebSocket, everything else to HTTP
      condition: op => op.type === 'subscription',
      true: wsLink({
        client: wsClient,
        transformer,
      }),
      false: httpBatchLink({
        url: getHttpUrl(),
        transformer,
      }),
    }),
  ]
}

export const trpc = createTRPCProxyClient<AppRouter>({
  links: getLinks(),
})
