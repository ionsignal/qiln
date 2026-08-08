import dts from 'vite-plugin-dts'
import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { sentinel } from './src/sentinel.ts'

export default defineConfig(({ mode }) => {
  const entry: Record<string, string> = {
    server: resolve(import.meta.dirname, 'src/server.ts'),
    sentinel: resolve(import.meta.dirname, 'src/sentinel.ts'),
  }
  if (mode !== 'development') {
    entry.client = resolve(import.meta.dirname, 'src/client.ts')
  }
  return {
    plugins: [
      dts({
        insertTypesEntry: true,
        include: ['src/**/*.ts'],
      }),
      sentinel(),
    ],
    build: {
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
          'zod',
          'yaml',
          'drizzle-orm',
          'drizzle-orm/pg-core',
          'drizzle-orm/postgres-js',
          '@nats-io/transport-node',
          // Externalize internal monorepo packages to prevent duplicate bundling
          /^@qiln\//,
          // Node.js built-in modules (with node: prefix)
          /^node:/,
        ],
        output: {
          preserveModules: false,
          exports: 'named',
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
