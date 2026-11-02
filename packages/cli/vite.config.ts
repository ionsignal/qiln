import { resolve } from 'node:path'
import { chmod } from 'node:fs/promises'
import dts from 'vite-plugin-dts'
import { defineConfig, type Plugin } from 'vite'

function isCliEntry(chunk: { name: string; isEntry: boolean }): boolean {
  return chunk.isEntry && chunk.name === 'cli'
}

/**
 * Vite empties the output directory on every build, so the executable bit that
 * npm sets when linking is lost on each rebuild, watch mode included. It is
 * restored here, after the file is written.
 */
function cli(): Plugin {
  return {
    name: 'qiln:cli:execute',
    async writeBundle({ dir }, bundle) {
      if (dir === undefined) {
        throw new Error('[QilnCli] CLI output directory is not configured.')
      }
      const entry = Object.values(bundle).find(output => output.type === 'chunk' && isCliEntry(output))
      if (entry === undefined) {
        throw new Error('[QilnCli] CLI entry chunk was not emitted.')
      }
      await chmod(resolve(dir, entry.fileName), 0o755)
    },
  }
}

export default defineConfig(() => {
  return {
    plugins: [
      cli(),
      dts({
        insertTypesEntry: true,
        include: ['src/**/*.ts'],
        exclude: ['src/aws/auth/process.ts', 'src/aws/iam/process.ts', 'src/aws/ec2/process.ts'],
      }),
    ],
    build: {
      lib: {
        entry: {
          index: resolve(import.meta.dirname, 'src/index.ts'),
          cli: resolve(import.meta.dirname, 'src/cli.ts'),
          aws: resolve(import.meta.dirname, 'src/aws/auth/process.ts'),
          iam: resolve(import.meta.dirname, 'src/aws/iam/process.ts'),
          ec2: resolve(import.meta.dirname, 'src/aws/ec2/process.ts'),
        },
        formats: ['es'],
        fileName: (_format, entryName) => `${entryName}.js`,
      },
      rolldownOptions: {
        checks: {
          pluginTimings: false,
        },
        external: [/^node:/, /^@aws-sdk\//, 'commander', 'ssh2'],
        output: {
          preserveModules: false,
          exports: 'named',
          chunkFileNames: '[name]-[hash].js',
          banner: chunk => (isCliEntry(chunk) ? '#!/usr/bin/env node\n' : ''),
        },
      },
      sourcemap: true,
      minify: false,
    },
  }
})
