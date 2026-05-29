import path from 'path'
import vike from 'vike/plugin'
import vue from '@vitejs/plugin-vue'
import { defineConfig, type UserConfig, type Plugin } from 'vite'

/**
 * Resolves the conflict between Vike's legacy `manualChunks` and our modern Rolldown
 * `codeSplitting` configuration. This is a temporary solution until Vike completely
 * supports Vite v8/v9 out-of-the-box.
 */
function silenceVikeManualChunksWarning(): Plugin {
  return {
    name: 'qiln:silence-vike-manual-chunks',
    enforce: 'post',
    configResolved(config) {
      const rolldownOutput = config.build?.rolldownOptions?.output
      const rollupOutput = config.build?.rollupOptions?.output
      const stripManualChunks = (output: any) => {
        if (!output) return
        const outputs = Array.isArray(output) ? output : [output]
        for (const opts of outputs) {
          if (opts.codeSplitting && opts.manualChunks) {
            delete opts.manualChunks
          }
        }
      }
      stripManualChunks(rolldownOutput)
      stripManualChunks(rollupOutput)
    },
  }
}

/**
 * Intercepts explicit CSS imports from our local packages during development
 * and serves an empty string. This prevents CSS duplication without needing dummy files.
 */
function ignorePackageCssInDev(isDev: boolean): Plugin {
  return {
    name: 'qiln:ignore-package-css',
    enforce: 'pre',
    resolveId(source) {
      // Only intercept during development, and only for our internal package CSS
      if (isDev && source.startsWith('@qiln/') && source.endsWith('/style.css')) {
        return '\0virtual:empty-css' // The \0 prefix tells Vite this is a virtual module
      }
      return null
    },
    load(id) {
      if (id === '\0virtual:empty-css') {
        return { code: '', map: null } // Serve empty CSS directly from memory
      }
      return null
    },
  }
}

export default defineConfig(({ isSsrBuild, command }): UserConfig => {
  const isDev = command === 'serve'
  return {
    plugins: [
      !process.env.VITEST && vike(),
      vue(),
      silenceVikeManualChunksWarning(),
      ignorePackageCssInDev(isDev),
    ],
    build: {
      target: 'esnext',
      chunkSizeWarningLimit: isSsrBuild ? 1500 : 900,
      rolldownOptions: {
        checks: {
          pluginTimings: false,
        },
        external: isSsrBuild ? [/^node:/, '@nats-io/transport-node', 'postgres', 'drizzle-orm/postgres-js'] : [],
        output: {
          codeSplitting: {
            groups: [
              // Core Frameworks
              { name: 'vendor-vue', test: /[\\/]node_modules[\\/](@vue|vue)[\\/]/ },
              { name: 'vendor-vike', test: /[\\/]node_modules[\\/]vike[\\/]/ },
              // UI Framework & Ecosystem (Bundling Naive UI with its strict dependencies)
              { name: 'vendor-naive-ui', test: /[\\/]node_modules[\\/](naive-ui|vueuc|@css-render|vfonts|date-fns)[\\/]/ },
              // Icons (Isolate to prevent cache busting the main vendor chunk when adding icons)
              { name: 'vendor-icons', test: /[\\/]node_modules[\\/]@mdi[\\/]js[\\/]/ },
              // API & Validation
              { name: 'vendor-trpc', test: /[\\/]node_modules[\\/](@trpc|superjson)[\\/]/ },
              { name: 'vendor-zod', test: /[\\/]node_modules[\\/]zod[\\/]/ },
              // Vue Flow
              { name: 'vendor-vue-flow', test: /[\\/]node_modules[\\/]@vue-flow[\\/]/ },
              // Internal Monorepo Packages
              { name: 'pkg-engine', test: /[\\/]packages[\\/]engine[\\/]/ },
              { name: 'pkg-core', test: /[\\/]packages[\\/]core[\\/]/ },
              // Catch-all for remaining dependencies MUST be last
              { name: 'vendor', test: /[\\/]node_modules[\\/]/ },
            ],
          },
        },
      },
    },
    ssr: {
      noExternal: ['naive-ui', 'vueuc', 'date-fns', 'vfonts'], // Naive UI dependencies
    },
    server: {
      hmr: {
        path: '/hmr',
        protocol: 'ws',
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './'),
        '@server': path.resolve(__dirname, './server'),
        // Dev-only aliases for instant HMR and CSS duplication prevention
        ...(isDev
          ? {
              '@qiln/core/client': path.resolve(__dirname, './packages/core/src/client.ts'),
              '@qiln/engine/client': path.resolve(__dirname, './packages/engine/src/client.ts'),
            }
          : {}),
      },
    },
  }
})
