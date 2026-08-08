import dts from 'vite-plugin-dts'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { sentinel } from '@qiln/core/sentinel'

export default defineConfig(({ mode }) => {
  const entry: Record<string, string> = {
    server: resolve(import.meta.dirname, 'src/server.ts'),
  }
  if (mode !== 'development') {
    entry.client = resolve(import.meta.dirname, 'src/client.ts')
  }
  return {
    plugins: [
      vue(),
      dts({
        insertTypesEntry: true,
        include: ['src/**/*.ts', 'src/**/*.vue'],
      }),
      sentinel(),
    ],

    build: {
      chunkSizeWarningLimit: 900,
      lib: {
        entry,
        formats: ['es'],
        fileName: (format, entryName) => `${entryName}.js`,
      },
      rolldownOptions: {
        checks: {
          pluginTimings: false,
        },
        external: [
          'vue',
          'naive-ui',
          '@vue-flow/core',
          '@trpc/client',
          'drizzle-orm',
          'drizzle-orm/pg-core',
          'drizzle-orm/postgres-js',
          '@trpc/server',
          'zod',
          '@nats-io/transport-node',
          'fastify',
          'fastify-plugin',
          'yaml',
          // Externalize internal monorepo packages to prevent duplicate bundling
          /^@qiln\//,
          // Node.js built-in modules (with node: prefix)
          /^node:/,
        ],
        output: {
          preserveModules: false,
          exports: 'named',
          globals: {
            vue: 'Vue',
            'naive-ui': 'naive',
          },
        },
      },
      sourcemap: true,
      minify: false,
    },
    resolve: {
      alias: {
        '@': resolve(import.meta.dirname, 'src'),
      },
    },
  }
})
