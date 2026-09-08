import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

const outputDirectory = resolve(import.meta.dirname, 'dist')

/**
 * The restart marker is written only after every output file has been written,
 * preventing the executable from starting against a partially emitted bundle.
 */
function readiness(): Plugin {
  return {
    name: 'qiln:ssh-readiness',
    async writeBundle() {
      await mkdir(outputDirectory, { recursive: true })
      await writeFile(resolve(outputDirectory, 'ready.json'), JSON.stringify({ builtAt: Date.now() }))
    },
  }
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [readiness()],
  resolve: {
    // Bundle package sources into an isolated executable. SSH development must
    // neither depend on Web's package watchers nor overwrite their dist files.
    alias: {
      '@qiln/core/server': resolve(import.meta.dirname, '../packages/core/src/server.ts'),
      '@qiln/ssh/server': resolve(import.meta.dirname, '../packages/ssh/src/server.ts'),
    },
  },
  ssr: {
    noExternal: ['@qiln/core', '@qiln/ssh'],
  },
  build: {
    ssr: resolve(import.meta.dirname, 'index.ts'),
    target: 'node22',
    outDir: outputDirectory,
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    rolldownOptions: {
      checks: {
        pluginTimings: false,
      },
      external: [
        /^node:/,
        /^drizzle-orm(?:\/|$)/,
        '@nats-io/transport-node',
        'c12',
        'close-with-grace',
        'pino',
        'postgres',
        'ssh2',
        'yaml',
        'zod',
      ],
      output: {
        entryFileNames: 'index.js',
        exports: 'named',
      },
    },
  },
})
