import dts from 'vite-plugin-dts'
import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { sentinel } from '@qiln/core/sentinel'

export default defineConfig(() => {
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
        entry: {
          server: resolve(import.meta.dirname, 'src/server.ts'),
        },
        formats: ['es'],
        fileName: (_format, entryName) => `${entryName}.js`,
      },
      rolldownOptions: {
        checks: {
          pluginTimings: false,
        },
        external: [
          '@nats-io/transport-node',
          'drizzle-orm',
          'drizzle-orm/pg-core',
          'drizzle-orm/postgres-js',
          'postgres',
          'undici',
          'ws',
          'yaml',
          'zod',
          /^@qiln\//,
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
