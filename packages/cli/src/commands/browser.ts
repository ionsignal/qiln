import { spawn } from 'node:child_process'
import { findExecutable } from '../transport/process'

/**
 * Requests the URL from the operator's default browser. Returns false only when
 * no opener exists or the launch cannot start. A true result does not prove that
 * a window appeared or which browser profile received the URL.
 */
export async function openInBrowser(url: string): Promise<boolean> {
  const opener = await findExecutable(process.platform === 'darwin' ? 'open' : 'xdg-open')
  if (opener === null) {
    return false
  }
  const child = spawn(opener, [url], {
    shell: false,
    detached: true,
    stdio: 'ignore',
  })
  child.on('error', () => {})
  child.unref()
  return child.pid !== undefined
}
