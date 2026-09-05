import superjson from 'superjson'
import { createTRPCProxyClient, httpBatchLink, splitLink, createWSClient, wsLink } from '@trpc/client'
import type { TRPCLink } from '@trpc/client'
import type { AppRouter } from '@server/trpc'

const transformer = superjson
const trpcPath = '/trpc'

let wsClient: ReturnType<typeof createWSClient> | undefined

function getLinks(): TRPCLink<AppRouter>[] {
  if (import.meta.env.SSR) {
    return [
      httpBatchLink({
        url: trpcPath,
        transformer,
        fetch: () => {
          throw new Error(
            '[api/trpc.ts] The browser tRPC client was used during SSR. ' +
              'Use pageContext.trpc for in-process server queries.',
          )
        },
      }),
    ]
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  wsClient = createWSClient({
    url: `${protocol}//${window.location.host}${trpcPath}`,
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
      condition: operation => operation.type === 'subscription',
      true: wsLink({
        client: wsClient,
        transformer,
      }),
      false: httpBatchLink({
        url: trpcPath,
        transformer,
      }),
    }),
  ]
}

export const trpc = createTRPCProxyClient<AppRouter>({
  links: getLinks(),
})

if (!import.meta.env.SSR && import.meta.hot) {
  import.meta.hot.dispose(() => {
    wsClient?.close()
    wsClient = undefined
  })
}
