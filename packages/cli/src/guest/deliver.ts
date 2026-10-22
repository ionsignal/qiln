import { randomUUID } from 'node:crypto'
import { InstallerError } from '../diagnostic/error'
import { SshError } from '../ssh/failure'
import type { Archive } from '../source/archive'
import type { Remote } from '../ssh/connections'

/**
 * The namespace is a literal and is never derived from the remote HOME. The
 * administrator account is a literal of the deployment record version, and the
 * preparation script checks ownership of every ancestor.
 */
const HOME = '/home/qiln'
const NAMESPACE = `${HOME}/.qiln-dev/pushes`
const ANCESTORS = [HOME, `${HOME}/.qiln-dev`, NAMESPACE] as const
const TOOLS = ['tar', 'gzip', 'sha256sum', 'stat'] as const
const UPLOAD_TIMEOUT_MS = 300_000
const EXTRACT_TIMEOUT_MS = 120_000
const DIGEST_OUTPUT = /^([0-9a-f]{64}) [ *]/

const STAGES = {
  tools: 'guest tool check',
  prepare: 'destination preparation',
  upload: 'archive upload',
  digest: 'remote digest comparison',
  extract: 'extraction',
} as const

type Stage = keyof typeof STAGES

/**
 * One fresh attempt on the guest. Every path derives from a generated UUID, so
 * none of them carries caller input into a shell string.
 */
export interface Destination {
  id: string
  directory: string
  archive: string
  source: string
}

/**
 * Carries only authored wording and the SSH layer's authored facts. Remote
 * artifacts are never removed, so the attempt path is evidence to inspect.
 */
export class DeliveryError extends InstallerError {
  constructor(stage: Stage, destination: Destination, reason: string, cause?: SshError) {
    super({
      code: cause?.kind === 'cancelled' ? 'COMMAND_CANCELLED' : 'AWS_DEPLOYMENT_DELIVERY_FAILED',
      facts: [
        ['Stage', STAGES[stage]],
        ['Attempt', destination.id],
        ['Attempt path', destination.directory],
        ['Reason', reason],
        ...(cause?.facts ?? []),
      ],
    })
  }
}

export function fresh(): Destination {
  const id = randomUUID()
  const directory = `${NAMESPACE}/${id}`
  return {
    id,
    directory,
    archive: `${directory}/archive.tar.gz`,
    source: `${directory}/source`,
  }
}

/**
 * Scripts contain no single quotes, so they travel as one literal argument.
 */
function shell(script: string): string {
  return `/bin/sh -c '${script}'`
}

async function guarded<T>(stage: Stage, destination: Destination, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error: unknown) {
    if (error instanceof SshError) {
      throw new DeliveryError(stage, destination, 'The connection or remote operation did not complete reliably.', error)
    }
    throw error
  }
}

/**
 * Confirms that the guest provides what the later stages call. Shell tests are
 * builtins, and SFTP availability is established by the upload itself.
 */
export async function tools(remote: Remote, destination: Destination): Promise<void> {
  const script = `for tool in ${TOOLS.join(' ')}; do command -v "$tool" >/dev/null 2>&1 || { echo "$tool"; exit 1; }; done`
  const result = await guarded('tools', destination, () => remote.exec(shell(script)))
  if (result.exitCode !== 0) {
    const missing = TOOLS.find(tool => tool === result.stdout.trim())
    throw new DeliveryError(
      'tools',
      destination,
      missing === undefined ? 'The tool check did not pass.' : `The guest does not provide ${missing}.`,
    )
  }
}

/**
 * Each ancestor is validated before the next one is used or created. The two
 * Qiln directories are created only when absent. The attempt and source
 * directories use nonrecursive mkdir, so existing state is a refusal. Exit
 * codes 20 to 22 name the failing ancestor, and 30 and 31 the fresh directories.
 */
function prepareScript(destination: Destination): string {
  return [
    'umask 077',
    'n=0',
    `for dir in ${ANCESTORS.join(' ')}; do`,
    '  if test "$n" -gt 0 && ! test -e "$dir" && ! test -L "$dir"; then',
    '    mkdir -m 700 "$dir" || exit $((20 + n))',
    '  fi',
    '  test ! -L "$dir" && test -d "$dir" && test -O "$dir" || exit $((20 + n))',
    '  mode=$(stat -c %a "$dir") || exit $((20 + n))',
    '  if test "$n" -eq 0; then',
    '    test $((0$mode & 022)) -eq 0 || exit $((20 + n))',
    '  else',
    '    test "$mode" = 700 || exit $((20 + n))',
    '  fi',
    '  n=$((n + 1))',
    'done',
    `mkdir -m 700 "${destination.directory}" || exit 30`,
    `mkdir -m 700 "${destination.source}" || exit 31`,
  ].join('\n')
}

function prepareReason(code: number): string {
  const ancestor = ANCESTORS[code - 20]
  if (ancestor !== undefined) {
    return `${ancestor} failed validation. It must be a real directory owned by the administrator account without group or other write access, and the Qiln directories must be exactly mode 700.`
  }
  if (code === 30) {
    return 'The fresh attempt directory could not be created. It may already exist, and nothing was replaced.'
  }
  if (code === 31) {
    return 'The source directory could not be created, and nothing was replaced.'
  }
  return `Preparation exited with code ${code}.`
}

export async function prepare(remote: Remote, destination: Destination): Promise<void> {
  const result = await guarded('prepare', destination, () => remote.exec(shell(prepareScript(destination))))
  if (result.exitCode !== 0) {
    throw new DeliveryError('prepare', destination, prepareReason(result.exitCode))
  }
}

/**
 * The approved digest is compared with the hash of the bytes actually sent.
 * The remote digest is compared separately by `digest`.
 */
export async function upload(
  remote: Remote,
  destination: Destination,
  archive: Archive,
  onProgress: (sent: number) => void,
): Promise<void> {
  const sent = await guarded('upload', destination, () =>
    remote.upload(archive.path, destination.archive, {
      timeoutMs: UPLOAD_TIMEOUT_MS,
      bytes: archive.bytes,
      onProgress,
    }),
  )
  if (sent.sha256 !== archive.sha256) {
    throw new DeliveryError('upload', destination, 'The bytes sent do not match the approved archive digest.')
  }
}

/**
 * Agreement establishes byte identity of the uploaded archive, not safe
 * archive structure.
 */
export async function digest(remote: Remote, destination: Destination, archive: Archive): Promise<void> {
  const result = await guarded('digest', destination, () => remote.exec(`sha256sum -- ${destination.archive}`))
  if (result.exitCode !== 0) {
    throw new DeliveryError('digest', destination, `sha256sum exited with code ${result.exitCode}.`)
  }
  const remoteDigest = DIGEST_OUTPUT.exec(result.stdout)?.[1]
  if (remoteDigest === undefined) {
    throw new DeliveryError('digest', destination, 'The remote digest output was not in the expected form.')
  }
  if (remoteDigest !== archive.sha256) {
    throw new DeliveryError('digest', destination, 'The remote archive digest differs from the approved digest.')
  }
}

/**
 * Runs without sudo. The flags constrain ownership and permission restoration
 * only; safe member paths and the absence of links are guaranteed when the
 * source is selected.
 */
export async function extract(remote: Remote, destination: Destination): Promise<void> {
  const command = `umask 022 && tar --no-same-owner --no-same-permissions -xzf ${destination.archive} -C ${destination.source}`
  const result = await guarded('extract', destination, () => remote.exec(command, { timeoutMs: EXTRACT_TIMEOUT_MS }))
  if (result.exitCode !== 0) {
    throw new DeliveryError(
      'extract',
      destination,
      `tar exited with code ${result.exitCode}. The source directory may be partially populated, and nothing was removed.`,
    )
  }
}
