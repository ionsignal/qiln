import { constants } from 'node:fs'
import { resolve } from 'node:path'
import { access } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'

/**
 * A zero-dependency, native Node.js replacement for `wait-on`. Polls the
 * filesystem for the existence of required build artifacts.
 *
 * Features:
 *
 * - 60-second hard timeout to prevent infinite hangs in CI/CD.
 * - 250ms polling interval to prevent CPU/Event Loop starvation.
 * - Cross-platform absolute path resolution.
 */
const files = process.argv.slice(2)
if (files.length === 0) {
  console.log('[wait-for] No files specified to wait for.')
  process.exit(0)
}
const TIMEOUT_MS = 60_000
const INTERVAL_MS = 250
const startTime = Date.now()
const targetPaths = files.map(f => resolve(process.cwd(), f))
console.log(`[wait-for] Waiting for ${targetPaths.length} file(s) to be created...`)
async function checkFiles() {
  while (true) {
    let allExist = true
    for (const file of targetPaths) {
      try {
        // F_OK checks for the existence of the file/directory
        await access(file, constants.F_OK)
      } catch {
        allExist = false
        break // Break early to save cycles; try again next interval
      }
    }
    if (allExist) {
      console.log('[wait-for] All files found. Proceeding with downstream tasks.')
      process.exit(0)
    }
    if (Date.now() - startTime > TIMEOUT_MS) {
      console.error(`\n[wait-for] FATAL: Timed out after ${TIMEOUT_MS}ms.`)
      console.error(`The following files were expected but not found:`)
      targetPaths.forEach(p => console.error(`  - ${p}`))
      process.exit(1)
    }
    // Yield the event loop to allow parallel compilers (tsc/vite) to do their work
    await setTimeout(INTERVAL_MS)
  }
}
checkFiles().catch(err => {
  console.error('[wait-for] Unexpected fatal error:', err)
  process.exit(1)
})
