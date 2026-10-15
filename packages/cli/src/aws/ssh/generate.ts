import { InstallerError, type DiagnosticFact } from '../../diagnostic/error'
import { findExecutable } from '../../process'
import { inspectChild, openChildDir, readChild, syncChild, type Dir } from '../../state/files'
import { runSetup } from '../child/setup'
import { SupervisedProcessError } from '../child/supervise'
import type { AdminKey } from '../deployment/types'
import { userId } from '../host'
import { AWS_SPEC } from '../spec'
import { parsePublicKey } from './key'

const GENERATION_TIMEOUT_MS = 30_000
const OUTPUT_LIMIT_BYTES = 16_384
const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin'

/**
 * Carries the supervised process's termination evidence, like the
 * authentication failure, so the caller retains the operation lock while an
 * unconfirmed `ssh-keygen` could still be writing into the protected directory.
 */
class KeyGenerationFailure extends InstallerError {
  public readonly terminationConfirmed: boolean

  constructor(error: SupervisedProcessError, location: string) {
    super({
      code: error.kind === 'cancelled' ? 'COMMAND_CANCELLED' : 'AWS_DEPLOYMENT_KEY_GENERATION_FAILED',
      facts: [
        ['Failure category', error.kind],
        ['Key generation termination', error.terminationConfirmed ? 'confirmed' : 'not confirmed'],
        ['Key directory', location],
      ],
    })
    this.terminationConfirmed = error.terminationConfirmed
  }
}

function failure(observed: string, location?: string): InstallerError {
  const facts: DiagnosticFact[] = [['Observed', observed]]
  if (location !== undefined) {
    facts.push(['Key directory', location])
  }
  return new InstallerError({
    code: 'AWS_DEPLOYMENT_KEY_GENERATION_FAILED',
    facts,
  })
}

function exactly(entries: readonly string[], expected: readonly string[]): boolean {
  const wanted = [...expected].sort()
  return entries.length === wanted.length && entries.every((name, index) => name === wanted[index])
}

/**
 * No AWS credentials, operator HOME, or other ambient state reaches the
 * subprocess. Only the executable lookup path and a fixed locale are needed.
 */
function keygenEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH || DEFAULT_PATH,
    LANG: 'C',
    LC_ALL: 'C',
  }
}

/**
 * Locates `ssh-keygen`, which only key generation needs. Callers use it before
 * approval so that a missing tool cannot strand an approved record. Without a
 * location the failure names no key directory, because none exists yet.
 */
export async function requireKeygen(location?: string): Promise<string> {
  const keygen = await findExecutable('ssh-keygen')
  if (keygen === null) {
    throw failure('ssh-keygen was not found on PATH. It is required only to generate the administrative key.', location)
  }
  return keygen
}

async function generate(directory: Dir, deploymentId: string, location: string, signal: AbortSignal): Promise<AdminKey> {
  const { state, limits } = AWS_SPEC
  const keygen = await requireKeygen(location)
  // Existing SSH storage, either key half, or any abandoned-work file is
  // evidence. It is refused, never filled in, reused, or replaced.
  if (!exactly(await directory.list(), [state.deployment])) {
    throw failure(
      'The deployment directory holds more than its approval record, so no key was generated and no existing key storage was reused.',
      location,
    )
  }
  const ssh = await openChildDir(directory, state.ssh, { owner: userId(), mode: 0o700 }, true)
  if ((await ssh.list()).length !== 0) {
    throw failure('The protected SSH directory was not empty when generation began.', location)
  }
  const privatePath = ssh.child(state.privateKey)
  const environment = keygenEnvironment()
  await runSetup(keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', `qiln-${deploymentId}`, '-f', privatePath], {
    environment,
    signal,
    timeoutMs: GENERATION_TIMEOUT_MS,
    maxOutputBytes: OUTPUT_LIMIT_BYTES,
    umask: { shell: '/bin/sh', mask: 0o077 },
  })
  if (!exactly(await ssh.list(), [state.privateKey, state.publicKey])) {
    throw failure('The protected SSH directory does not contain exactly the generated key pair.', location)
  }
  // Qiln never reads private-key bytes; ownership and mode are all it checks.
  const kind = await inspectChild(ssh, state.privateKey, {
    owner: userId(),
    fileMode: 0o600,
    maxFileSize: limits.privateKey,
  })
  if (kind !== 'file') {
    throw failure('The generated private key is not a regular file.', location)
  }
  const publicFile = await readChild(ssh, state.publicKey, {
    owner: userId(),
    mode: 0o600,
    minSize: 1,
    maxSize: limits.publicKey,
  })
  const parsed = parsePublicKey(new TextDecoder('utf-8', { fatal: true }).decode(publicFile.bytes).trim())
  if (parsed === null) {
    throw failure('The generated public key is not a canonical Ed25519 OpenSSH public key.', location)
  }
  // The public file is not trusted on its own: the private half must derive
  // the same key blob.
  const derived = await runSetup(keygen, ['-y', '-P', '', '-f', privatePath], {
    environment,
    signal,
    timeoutMs: GENERATION_TIMEOUT_MS,
    maxOutputBytes: OUTPUT_LIMIT_BYTES,
  })
  const derivedKey = parsePublicKey(derived.stdout.trim())
  if (derivedKey === null || !derivedKey.blob.equals(parsed.blob)) {
    throw failure('The private and public key halves do not agree.', location)
  }
  // Directory synchronization does not flush file contents, so each file is
  // flushed first and the directory entries after.
  await syncChild(ssh, state.privateKey, { owner: userId(), mode: 0o600, minSize: 1, maxSize: limits.privateKey })
  await syncChild(ssh, state.publicKey, { owner: userId(), mode: 0o600, minSize: 1, maxSize: limits.publicKey })
  await ssh.sync()
  return {
    algorithm: 'ed25519',
    fingerprint: parsed.fingerprint,
    generatedAt: new Date().toISOString(),
  }
}

/**
 * Generates the deployment's one administrative key directly into its protected
 * SSH directory. Partial output is retained as evidence on every failure; this
 * function never removes, repairs, or regenerates anything. Call it only from
 * the parent, under the operation lock and an unconfirmed-termination fence.
 */
export async function generateAdminKey(directory: Dir, deploymentId: string, signal: AbortSignal): Promise<AdminKey> {
  const location = directory.child(AWS_SPEC.state.ssh)
  try {
    return await generate(directory, deploymentId, location, signal)
  } catch (error: unknown) {
    if (error instanceof SupervisedProcessError) {
      throw new KeyGenerationFailure(error, location)
    }
    if (error instanceof InstallerError) {
      throw error
    }
    throw failure('Protected key storage or the generated key pair could not be validated safely.', location)
  }
}
