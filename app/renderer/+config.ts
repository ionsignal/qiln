import type { Config } from 'vike/types'
import LayoutQiln from '@/renderer/layout/LayoutQiln.vue'

// https://vike.dev/config
const config = {
  prerender: false,
  clientRouting: true,
  prefetchStaticAssets: 'viewport',
  // https://vike.dev/passToClient
  // Removed 'pageProps' - Vike passes 'data' automatically
  passToClient: ['user'],
  // https://vike.dev/meta
  // set default layout
  Layout: LayoutQiln,
  meta: {
    // Define setting 'title'
    title: {
      env: { server: true, client: true },
    },
    // Define setting 'description'
    description: {
      env: { server: true, client: true },
    },
    // Define setting 'Layout'
    Layout: {
      // cumulative: true,
      env: { server: true, client: true },
    },
  },
  // set redirects
  redirects: {
    '/': '/admin/capsules',
    '/admin': '/admin/capsules',
    '/admin/workspace': '/admin/capsules',
    '/admin/workspace/': '/admin/capsules',
    '/admin/workspace/vessels': '/admin/capsules',
    '/admin/workspace/vaults': '/admin/capsules',
    '/admin/forge': '/admin/capsules',
  },
} satisfies Config

export { config }
