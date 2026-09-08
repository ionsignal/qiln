import fs from 'node:fs/promises'

/**
 * Gateway identity survives process restarts and is supplied only to the SSH
 * application, never to the Web Host.
 */
export async function readHostKey(path: string): Promise<Buffer> {
  if (path.trim() === '') {
    throw new Error('QILN_SSH_GATEWAY_HOST_KEY_PATH is required when the SSH gateway is enabled.')
  }
  const metadata = await fs.stat(path)
  if (!metadata.isFile()) {
    throw new Error('The configured SSH gateway host key path must identify a regular file.')
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error('The SSH gateway host key must not be readable or writable by group or other users.')
  }
  const key = await fs.readFile(path)
  if (key.length === 0) {
    throw new Error('The configured SSH gateway host key is empty.')
  }
  return key
}
