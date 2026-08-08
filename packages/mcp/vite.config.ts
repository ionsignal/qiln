import dts from 'vite-plugin-dts'
import { defineConfig, type Plugin } from 'vite'
import { resolve } from 'node:path'

function addCliShebang(): Plugin {
  return {
    name: 'qiln:mcp-cli-shebang',
    generateBundle(_, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk' || !output.isEntry || output.name !== 'cli') {
          continue
        }
        output.code = `#!/usr/bin/env node\n${output.code}`
        return
      }
      throw new Error('[QilnMcp] CLI entry chunk was not emitted.')
    },
  }
}

function externalRuntimeDependency(isDevelopment: boolean) {
  return (source: string): boolean => {
    if (source.startsWith('node:')) {
      return true
    }
    if (isDevelopment && (source === '@qiln/agent' || source === '@qiln/core/client')) {
      return false
    }
    if (
      source === 'zod' ||
      source === '@modelcontextprotocol/server' ||
      source.startsWith('@modelcontextprotocol/server/')
    ) {
      return true
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
          index: resolve(import.meta.dirname, 'src/index.ts'),
          server: resolve(import.meta.dirname, 'src/server.ts'),
          cli: resolve(import.meta.dirname, 'src/cli.ts'),
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
            '@qiln/agent': resolve(import.meta.dirname, '../agent/src/index.ts'),
            '@qiln/core/client': resolve(import.meta.dirname, '../core/src/client.ts'),
          }
        : undefined,
    },
  }
})
