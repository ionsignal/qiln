import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const library = require('ssh2') as typeof import('ssh2')

if (typeof library.Server !== 'function') {
  throw new Error("The installed 'ssh2' package does not expose the required Server constructor.")
}

if (typeof library.utils?.parseKey !== 'function') {
  throw new Error("The installed 'ssh2' package does not expose the required utils.parseKey function.")
}

export const SshServer = library.Server
export const ssh2Utils = library.utils
