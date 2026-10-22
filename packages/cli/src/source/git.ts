import { InstallerError, type InstallerErrorCode } from '../diagnostic/error'
import { validateSourcePreflight } from '../checks/source'
import { findExecutable, ProcessExecutionError, runProcess, type ProcessFailureKind, type ProcessResult } from '../process'
import { checkCancellation } from '../terminal/prompts'
import { missingTool, refuse } from './errors'
import { SOURCE_SPEC } from './spec'

const PROCESS_CODES = {
  start: 'PREFLIGHT_PROCESS_START_FAILED',
  timeout: 'PREFLIGHT_PROCESS_TIMEOUT',
  output: 'PREFLIGHT_PROCESS_OUTPUT_LIMIT_EXCEEDED',
} as const satisfies Record<ProcessFailureKind, InstallerErrorCode>

export interface Listing {
  root: string
  tracked: string[]
  untracked: string[]
}

async function runGit(executable: string, directory: string, args: readonly string[]): Promise<ProcessResult> {
  try {
    return await runProcess(executable, ['-C', directory, ...args], {
      timeoutMs: SOURCE_SPEC.git.timeoutMs,
      maxOutputBytes: SOURCE_SPEC.git.maxOutputBytes,
    })
  } catch (error: unknown) {
    if (error instanceof ProcessExecutionError) {
      throw new InstallerError({
        code: PROCESS_CODES[error.kind],
        facts: [['Command', error.command]],
        retry: 'qiln aws deployment push',
      })
    }
    throw error
  }
}

async function listOutput(executable: string, root: string, args: readonly string[], what: string): Promise<string> {
  const result = await runGit(executable, root, args)
  if (result.exitCode !== 0) {
    throw refuse(`Git could not list ${what}.`)
  }
  return result.stdout
}

/**
 * `runProcess` decodes output with replacement characters, so an invalid byte
 * sequence in a path always surfaces as U+FFFD. A listing without it was valid
 * UTF-8 throughout. A path that genuinely contains U+FFFD is refused as well.
 */
function records(output: string): string[] {
  if (output.includes('\uFFFD')) {
    throw refuse('A source path is not valid UTF-8.')
  }
  if (output === '') {
    return []
  }
  if (!output.endsWith('\0')) {
    throw refuse('Git returned an incomplete listing.')
  }
  return output.slice(0, -1).split('\0')
}

function tagReason(tag: string): string {
  if (tag === 'S') {
    return 'skip-worktree (sparse checkout)'
  }
  if (tag === 'M') {
    return 'unmerged'
  }
  if (tag !== tag.toUpperCase()) {
    return 'marked assume-unchanged or skip-worktree'
  }
  return 'in an unsupported state'
}

/**
 * Only the plain `H` tag is admitted. Unmerged paths can repeat once per
 * stage, so paths are de-duplicated.
 */
function trackedPaths(output: string): string[] {
  const paths = new Set<string>()
  for (const record of records(output)) {
    const tag = record.charAt(0)
    if (record.length < 3 || record.charAt(1) !== ' ') {
      throw refuse('Git returned an unrecognized tracked-file record.')
    }
    if (tag !== 'H') {
      throw refuse(`Tracked files must be in the normal state, but a tracked file is ${tagReason(tag)}.`)
    }
    paths.add(record.slice(2))
  }
  return [...paths]
}

/**
 * Lists what a developer would consider the current source: tracked paths and
 * untracked non-ignored paths of the Git checkout that contains `directory`.
 * Deleted tracked files still appear here and are dropped by the caller when
 * the filesystem confirms they are gone.
 */
export async function listSource(directory: string, signal: AbortSignal): Promise<Listing> {
  const executable = await findExecutable('git')
  if (executable === null) {
    throw missingTool('git')
  }
  checkCancellation(signal)
  const top = await runGit(executable, directory, ['rev-parse', '--show-toplevel'])
  const location = top.stdout.trim()
  if (top.exitCode !== 0 || location === '') {
    throw new InstallerError({
      code: 'SOURCE_NOT_GIT_CHECKOUT',
      facts: [['Observed', 'The invoking directory is not inside a Git working tree.']],
      retry: 'qiln aws deployment push',
    })
  }
  const { sourceRoot: root } = await validateSourcePreflight(location, executable)
  checkCancellation(signal)
  const sparse = await runGit(executable, root, ['config', '--bool', '--get', 'core.sparseCheckout'])
  // Exit 1 means the setting is absent, which is the normal case.
  if (sparse.exitCode !== 0 && sparse.exitCode !== 1) {
    throw refuse('Git could not read its sparse-checkout setting.')
  }
  if (sparse.exitCode === 0 && sparse.stdout.trim() === 'true') {
    throw refuse('Sparse checkouts are not supported, because omitted files would silently be missing from the package.')
  }
  checkCancellation(signal)
  if ((await listOutput(executable, root, ['ls-files', '--unmerged', '-z'], 'unmerged paths')) !== '') {
    throw refuse('The working tree has unresolved merge conflicts.')
  }
  checkCancellation(signal)
  const tracked = trackedPaths(await listOutput(executable, root, ['ls-files', '-v', '-z', '--cached'], 'tracked files'))
  checkCancellation(signal)
  const untracked = records(
    await listOutput(executable, root, ['ls-files', '--others', '--exclude-standard', '-z'], 'untracked files'),
  )
  if (tracked.length + untracked.length > SOURCE_SPEC.limits.entries) {
    throw refuse(`More than ${SOURCE_SPEC.limits.entries} paths were enumerated.`)
  }
  return {
    root,
    tracked,
    untracked,
  }
}
