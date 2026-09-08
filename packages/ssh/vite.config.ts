import dts from 'vite-plugin-dts'
import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig(() => {
  return {
    plugins: [
      dts({
        insertTypesEntry: true,
        include: ['src/**/*.ts'],
      }),
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
        external: ['postgres', 'ssh2', /^drizzle-orm(?:\/|$)/, /^@qiln\//, /^node:/],
        output: {
          preserveModules: false,
          exports: 'named',
        },
      },
      sourcemap: true,
      minify: false,
    },
  }
})
