import dts from 'vite-plugin-dts'
import { defineConfig, type Plugin } from 'vite'
import { resolve } from 'node:path'

function addCliShebang(): Plugin {
  return {
    name: 'qiln:agent-cli-shebang',
    generateBundle(_, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk' || !output.isEntry || output.name !== 'cli') {
          continue
        }
        output.code = `#!/usr/bin/env node\n${output.code}`
        return
      }
      throw new Error('[QilnAgent] CLI entry chunk was not emitted.')
    },
  }
}

function externalRuntimeDependency(isDevelopment: boolean) {
  return (source: string): boolean => {
    if (source.startsWith('node:')) {
      return true
    }
    // The Core development build intentionally omits client.js. Bundle the
    // client-safe source surface into the development-only Agent CLI instead.
    if (isDevelopment && source === '@qiln/core/client') {
      return false
    }
    return source.startsWith('@qiln/')
  }
}

export default defineConfig(({ mode }) => {
  const isDevelopment = mode === 'development'
  return {
    plugins: [
      addCliShebang(),
      dts({
        insertTypesEntry: true,
        include: ['src/**/*.ts'],
      }),
    ],
    build: {
      lib: {
        entry: {
          index: resolve(__dirname, 'src/index.ts'),
          client: resolve(__dirname, 'src/client.ts'),
          cli: resolve(__dirname, 'src/cli.ts'),
        },
        formats: ['es'],
        fileName: (_format, entryName) => `${entryName}.js`,
      },
      rolldownOptions: {
        checks: {
          pluginTimings: false,
        },
        external: externalRuntimeDependency(isDevelopment),
        output: {
          preserveModules: false,
          exports: 'named',
        },
      },
      sourcemap: true,
      minify: false,
    },
    resolve: {
      alias: isDevelopment
        ? {
            '@qiln/core/client': resolve(__dirname, '../core/src/client.ts'),
          }
        : undefined,
    },
  }
})
