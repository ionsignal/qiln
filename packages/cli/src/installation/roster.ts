import { basename, dirname, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import { InstallerError } from '../diagnostic/error'
import { isErrorCode } from '../guards'
import { runProcess } from '../transport/process'
import { FileValidationError, openDir, readChild, withTemp, type Dir, type FileSnapshot } from '../state/files'
import { currentUserId } from '../state/user'

const MAX_AUTHORIZED_KEYS_BYTES = 1_048_576
const PUBLIC_KEY_BLOB_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/
const SUPPORTED_AUTHORIZED_KEY_ALGORITHMS = new Set([
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
])

function rosterReadError(error: unknown, path: string, retry: string): InstallerError {
  if (isErrorCode(error, 'ENOENT')) {
    return new InstallerError({
      code: 'AUTHORIZED_KEYS_NOT_FOUND',
      facts: [['Observed', `No readable roster was found at ${path}.`]],
      retry,
    })
  }
  if (error instanceof FileValidationError && error.kind === 'owner') {
    return new InstallerError({
      code: 'INVALID_AUTHORIZED_KEYS_OWNER',
      facts: [['Observed', `${path} does not have the expected UID ${currentUserId()} ownership.`]],
      retry,
    })
  }
  return new InstallerError({
    code: 'INVALID_AUTHORIZED_KEYS_FILE',
    facts: [['Observed', `${path} could not be opened as a stable bounded regular file.`]],
    retry,
  })
}

/**
 * Reads one developer-managed authorized-key roster into a stable validated
 * snapshot without reopening its path for later content validation.
 */
export async function readRoster(rosterPath: string, retry: string): Promise<FileSnapshot> {
  const path = resolve(rosterPath)
  let directory: Dir
  try {
    directory = await openDir(dirname(path))
  } catch (error: unknown) {
    throw rosterReadError(error, path, retry)
  }
  try {
    return await readChild(directory, basename(path), {
      owner: currentUserId(),
      minSize: 1,
      maxSize: MAX_AUTHORIZED_KEYS_BYTES,
    })
  } catch (error: unknown) {
    throw rosterReadError(error, path, retry)
  }
}

/**
 * Validates the supplied in-memory roster snapshot and runs ssh-keygen only
 * against a temporary file containing those exact validated bytes.
 */
export async function validateRoster(
  roster: FileSnapshot,
  sshKeygenExecutable: string,
  retry: string,
): Promise<FileSnapshot> {
  let content: string
  try {
    content = new TextDecoder('utf-8', {
      fatal: true,
    }).decode(roster.bytes)
  } catch (error: unknown) {
    throw new InstallerError({
      code: 'INVALID_AUTHORIZED_KEYS_CONTENT',
      facts: [['Observed', 'The validated roster snapshot could not be decoded as UTF-8.']],
      retry,
    })
  }
  let publicKeyCount = 0
  for (const [index, line] of content.split('\n').entries()) {
    if (line.includes('\r') || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(line)) {
      throw new InstallerError({
        code: 'INVALID_AUTHORIZED_KEYS_CONTENT',
        facts: [['Observed', `Unsupported content was found at line ${index + 1}.`]],
        retry,
      })
    }
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue
    }
    const fields = trimmed.split(/\s+/)
    const algorithm = fields[0]
    const encodedKey = fields[1]
    if (
      fields.length < 2 ||
      algorithm === undefined ||
      encodedKey === undefined ||
      !SUPPORTED_AUTHORIZED_KEY_ALGORITHMS.has(algorithm) ||
      !PUBLIC_KEY_BLOB_PATTERN.test(encodedKey)
    ) {
      throw new InstallerError({
        code: 'INVALID_AUTHORIZED_KEYS_CONTENT',
        facts: [['Observed', `Line ${index + 1} is not a normal supported OpenSSH public-key line.`]],
        retry,
      })
    }
    const decoded = Buffer.from(encodedKey, 'base64')
    if (decoded.length === 0 || decoded.toString('base64') !== encodedKey) {
      throw new InstallerError({
        code: 'INVALID_AUTHORIZED_KEYS_CONTENT',
        facts: [['Observed', `Line ${index + 1} does not contain canonical Base64 public-key data.`]],
        retry,
      })
    }
    publicKeyCount++
  }
  if (publicKeyCount === 0) {
    throw new InstallerError({
      code: 'EMPTY_AUTHORIZED_KEYS_ROSTER',
      facts: [['Observed', 'The selected roster snapshot contains only blank lines or comments.']],
      retry,
    })
  }
  const validation = await withTemp(roster, path => runProcess(sshKeygenExecutable, ['-l', '-f', path]))
  if (validation.exitCode !== 0 || validation.stdout.trim() === '') {
    throw new InstallerError({
      code: 'INVALID_AUTHORIZED_KEYS_ROSTER',
      facts: [['Observed', 'The validated roster snapshot failed ssh-keygen public-key inspection.']],
      retry,
    })
  }
  return roster
}
