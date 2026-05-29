import dts from 'vite-plugin-dts'
import { defineConfig } from 'vite'
import { resolve } from 'path'
import { sentinel } from './src/sentinel'

export default defineConfig(({ mode }) => {
  const entry: Record<string, string> = {
    server: resolve(__dirname, 'src/server.ts'),
    sentinel: resolve(__dirname, 'src/sentinel.ts'),
  }
  // Only include the client entry in production/build mode
  if (mode !== 'development') {
    entry.client = resolve(__dirname, 'src/client.ts')
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
        '@': resolve(__dirname, 'src'),
      },
    },
  }
})
