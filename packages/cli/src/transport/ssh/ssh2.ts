import { createRequire } from 'node:module'
import type * as Ssh2Types from 'ssh2'

type Ssh2 = typeof Ssh2Types

/**
 * ssh2 is CommonJS. Node derives a CommonJS module's named ESM exports by
 * static analysis, which is heuristic and does not see `utils`, so a named
 * import fails at link time and takes down every command. Loading through
 * `require` reads `module.exports` directly. This is the only module that
 * loads ssh2 at runtime; every other file imports its types only. It is
 * loaded eagerly, like the static import it replaces, so a broken install
 * fails at startup instead of being mistaken for a refused key.
 */
const nodeRequire = createRequire(import.meta.url)
const loaded: unknown = nodeRequire('ssh2')

function isSsh2(value: unknown): value is Ssh2 {
  return (
    typeof value === 'object' &&
    value !== null &&
    'Client' in value &&
    typeof value.Client === 'function' &&
    'utils' in value &&
    typeof value.utils === 'object' &&
    value.utils !== null &&
    'parseKey' in value.utils &&
    typeof value.utils.parseKey === 'function'
  )
}

if (!isSsh2(loaded)) {
  throw new Error('The ssh2 module does not provide the Client and utils.parseKey interfaces that Qiln requires.')
}

export const SshClient = loaded.Client
export const ssh2Utils = loaded.utils
