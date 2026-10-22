import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { InstallerError } from '../diagnostic/error'
import { runSetup } from '../aws/child/setup'
import { SupervisedProcessError } from '../aws/child/supervise'
import { findExecutable, runProcess } from '../process'
import { checkCancellation } from '../terminal/prompts'
import { missingTool, refuse } from './errors'
import { isSameSelection, selectSource, type Selection } from './select'
import { MIB, SOURCE_SPEC } from './spec'

const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin'

export interface Archive {
  path: string
  bytes: number
  sha256: string
}

interface ArchiveFailureOptions {
  reason: string
  cancelled?: boolean
  terminationConfirmed?: boolean
  retained?: string
}

/**
 * Carries the supervised process's termination evidence, so the caller keeps
 * the operation lock while an unconfirmed tar could still be writing into the
 * retained work directory.
 */
export class ArchiveFailure extends InstallerError {
  public readonly terminationConfirmed: boolean

  constructor(options: ArchiveFailureOptions) {
    const terminationConfirmed = options.terminationConfirmed ?? true
    super({
      code: options.cancelled ? 'COMMAND_CANCELLED' : 'SOURCE_ARCHIVE_FAILED',
      facts: [
        ['Reason', options.reason],
        ['Tar termination', terminationConfirmed ? 'confirmed' : 'not confirmed'],
        ...(options.retained === undefined ? [] : ([['Work directory', options.retained]] as const)),
      ],
      retry: options.cancelled ? undefined : 'qiln aws deployment push',
    })
    this.terminationConfirmed = terminationConfirmed
  }
}

/**
 * Only an explicit environment reaches tar, so `TAR_OPTIONS` cannot change what
 * it does. `COPYFILE_DISABLE` is not enough on its own to suppress macOS
 * metadata, which is why `tarArguments` also passes explicit flags.
 */
function tarEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH || DEFAULT_PATH,
    LANG: 'C',
    LC_ALL: 'C',
    COPYFILE_DISABLE: '1',
  }
}

/**
 * GNU tar and bsdtar share creation, `--null -T`, and `--no-recursion`, but
 * differ in the metadata flags they accept, so the executable is asked which
 * one it is. `--no-recursion` and `--null` must precede `-T`.
 */
async function tarArguments(tar: string, archivePath: string, listPath: string): Promise<string[]> {
  const version = await runProcess(tar, ['--version'])
  const metadata = version.stdout.includes('bsdtar')
    ? ['--no-mac-metadata', '--no-xattrs', '--no-acls', '--no-fflags']
    : ['--no-xattrs', '--no-acls']
  return ['-c', '-z', '-f', archivePath, ...metadata, '--no-recursion', '--null', '-T', listPath]
}

function tarReason(error: SupervisedProcessError): string {
  switch (error.kind) {
    case 'start':
      return 'tar could not be started.'
    case 'timeout':
      return 'tar exceeded its deadline.'
    case 'output':
      return 'tar exceeded its output limit.'
    case 'exit':
      return error.exitCode === 1
        ? 'tar reported that a file changed or could not be read while it was being packaged.'
        : 'tar did not complete successfully.'
    default:
      return 'tar did not complete cleanly.'
  }
}

function tarFailure(error: SupervisedProcessError, workDirectory: string): ArchiveFailure {
  return new ArchiveFailure({
    reason: tarReason(error),
    cancelled: error.kind === 'cancelled',
    terminationConfirmed: error.terminationConfirmed,
    retained: error.terminationConfirmed
      ? undefined
      : `${basename(workDirectory)} under the system temporary directory; kept because tar termination was not confirmed`,
  })
}

async function digest(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    hash.update(chunk)
    bytes += chunk.byteLength
  }
  return {
    bytes,
    sha256: hash.digest('hex'),
  }
}

/**
 * The size check runs after tar finishes, so it is not a bound on disk use
 * while the archive is being generated: tar takes its own file-size
 * observations, and a file can grow between them. Only the tar deadline limits
 * generation.
 */
async function capture(
  tar: string,
  workDirectory: string,
  directory: string,
  selection: Selection,
  signal: AbortSignal,
): Promise<Archive> {
  const archivePath = join(workDirectory, SOURCE_SPEC.archive.name)
  const listPath = join(workDirectory, SOURCE_SPEC.archive.listName)
  checkCancellation(signal)
  await writeFile(listPath, selection.files.map(file => `./${file.path}\0`).join(''), {
    mode: 0o600,
    flag: 'wx',
  })
  const args = await tarArguments(tar, archivePath, listPath)
  try {
    await runSetup(tar, args, {
      cwd: selection.root,
      environment: tarEnvironment(),
      signal,
      timeoutMs: SOURCE_SPEC.tar.timeoutMs,
      maxOutputBytes: SOURCE_SPEC.tar.maxOutputBytes,
    })
  } catch (error: unknown) {
    throw error instanceof SupervisedProcessError ? tarFailure(error, workDirectory) : error
  }
  if (!isSameSelection(selection, await selectSource(directory, signal))) {
    throw refuse('The source changed while it was being packaged. Run the command again once edits settle.')
  }
  const metadata = await lstat(archivePath)
  if (!metadata.isFile() || metadata.size === 0) {
    throw new ArchiveFailure({ reason: 'tar did not produce a regular, non-empty archive file.' })
  }
  if (metadata.size > SOURCE_SPEC.limits.archiveBytes) {
    throw refuse(`The compressed archive exceeds ${SOURCE_SPEC.limits.archiveBytes / MIB} MiB.`)
  }
  const { bytes, sha256 } = await digest(archivePath)
  if (bytes !== metadata.size) {
    throw new ArchiveFailure({ reason: 'The archive changed while it was being hashed.' })
  }
  return {
    path: archivePath,
    bytes,
    sha256,
  }
}

/**
 * Captures the selection into one private `.tar.gz`, then lends it to `use`
 * (approval and upload) and removes the work directory afterwards. The
 * directory is kept only when tar termination is unconfirmed, because tar may
 * still be writing into it. `directory` is the invoking directory, which is
 * rescanned after packaging to detect edits.
 */
export async function withArchive<T>(
  directory: string,
  selection: Selection,
  signal: AbortSignal,
  use: (archive: Archive) => Promise<T>,
): Promise<T> {
  const tar = await findExecutable('tar')
  if (tar === null) {
    throw missingTool('tar')
  }
  let workDirectory: string
  try {
    workDirectory = await mkdtemp(join(tmpdir(), SOURCE_SPEC.archive.workPrefix))
    await chmod(workDirectory, 0o700)
  } catch {
    throw new ArchiveFailure({ reason: 'The private work directory could not be created.' })
  }
  let retain = false
  try {
    let archive: Archive
    try {
      archive = await capture(tar, workDirectory, directory, selection, signal)
    } catch (error: unknown) {
      const failure =
        error instanceof InstallerError
          ? error
          : new ArchiveFailure({
              reason: 'The archive could not be created, read, or measured in its private work directory.',
            })
      retain = failure instanceof ArchiveFailure && !failure.terminationConfirmed
      throw failure
    }
    return await use(archive)
  } finally {
    if (!retain) {
      await rm(workDirectory, {
        recursive: true,
        force: true,
      }).catch(() => undefined)
    }
  }
}
