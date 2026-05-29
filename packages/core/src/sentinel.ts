import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { Plugin } from 'vite'

export interface SmartSentinelOptions {
  // The name of the output chunk to monitor. Defaults to 'server.js'
  chunkName?: string
  // Path to the sentinel file to write for boot synchronization.
  sentinelFile?: string
  // Path to the host tsconfig to touch to trigger nodemon.
  hostTsConfig?: string
}

/**
 * A Vite plugin that monitors a specific output chunk during watch mode.
 * It computes a SHA-256 hash of the compiled code and only triggers a host
 * server restart if the backend logic actually changed, ignoring frontend-only HMR builds.
 */
export function sentinel(options: SmartSentinelOptions = {}): Plugin {
  const chunkName = options.chunkName ?? 'server.js'
  const sentinelFile = options.sentinelFile ?? 'dist/.build-complete'
  const hostTsConfig = options.hostTsConfig ?? '../../server/tsconfig.json'
  let lastHash = ''
  return {
    name: 'qiln:smart-sentinel',
    writeBundle(_, bundle) {
      const chunk = bundle[chunkName]
      if (!chunk || chunk.type !== 'chunk') {
        return
      }
      const hash = createHash('sha256').update(chunk.code).digest('hex')
      if (hash === lastHash) {
        return
      }
      lastHash = hash
      const now = new Date()
      const resolvedSentinel = path.resolve(process.cwd(), sentinelFile)
      const sentinelDir = path.dirname(resolvedSentinel)
      if (!fs.existsSync(sentinelDir)) {
        fs.mkdirSync(sentinelDir, { recursive: true })
      }
      fs.writeFileSync(resolvedSentinel, now.getTime().toString())
      const resolvedTsConfig = path.resolve(process.cwd(), hostTsConfig)
      if (fs.existsSync(resolvedTsConfig)) {
        try {
          fs.utimesSync(resolvedTsConfig, now, now)
          console.log(`[smart-sentinel] Backend code changed (${chunkName}). Triggered host server restart.`)
        } catch (err) {
          console.error(`[smart-sentinel] Failed to trigger server rebuild:`, err)
        }
      }
    },
  }
}
