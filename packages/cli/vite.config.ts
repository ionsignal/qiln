import { resolve } from 'node:path'
import dts from 'vite-plugin-dts'
import { defineConfig, type Plugin } from 'vite'

function addCliShebang(): Plugin {
  return {
    name: 'qiln:cli-shebang',
    generateBundle(_, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk' || !output.isEntry || output.name !== 'cli') {
          continue
        }

        output.code = `#!/usr/bin/env node\n${output.code}`
        return
      }

      throw new Error('[QilnCli] CLI entry chunk was not emitted.')
    },
  }
}

export default defineConfig(() => {
  return {
    plugins: [
      addCliShebang(),
      dts({
        insertTypesEntry: true,
        include: ['src/**/*.ts'],
        exclude: ['src/aws/auth/process.ts', 'src/aws/bootstrap/process.ts'],
      }),
    ],
    build: {
      lib: {
        entry: {
          index: resolve(import.meta.dirname, 'src/index.ts'),
          cli: resolve(import.meta.dirname, 'src/cli.ts'),
          aws: resolve(import.meta.dirname, 'src/aws/auth/process.ts'),
          bootstrap: resolve(import.meta.dirname, 'src/aws/bootstrap/process.ts'),
        },
        formats: ['es'],
        fileName: (_format, entryName) => `${entryName}.js`,
      },
      rolldownOptions: {
        checks: {
          pluginTimings: false,
        },
        external: [/^node:/, /^@aws-sdk\//, 'commander'],
        output: {
          preserveModules: false,
          exports: 'named',
          chunkFileNames: '[name]-[hash].js',
        },
      },
      sourcemap: true,
      minify: false,
    },
  }
})
