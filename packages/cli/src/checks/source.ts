import { constants } from 'node:fs'
import { access, lstat, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { InstallerError } from '../diagnostic/error'
import { runProcess } from '../process'

const MAX_PACKAGE_JSON_BYTES = 1_048_576

export interface SourcePreflight {
  sourceRoot: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function assertSourceDirectory(path: string): Promise<void> {
  let metadata
  try {
    metadata = await lstat(path)
  } catch (error: unknown) {
    throw new InstallerError({
      code: 'INVALID_SOURCE_CHECKOUT',
      facts: [['Observed', `${path} could not be inspected.`]],
      retry: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new InstallerError({
      code: 'INVALID_SOURCE_CHECKOUT',
      facts: [['Observed', `${path} is not a real directory.`]],
      retry: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
}

/**
 * Source validation proves that the supplied path is the Git checkout root and
 * contains a bounded Qiln package descriptor. It intentionally does not
 * validate workspace membership, package completeness, or project layout.
 */
export async function validateSourcePreflight(sourcePath: string, gitExecutable: string): Promise<SourcePreflight> {
  const requestedPath = resolve(sourcePath)
  let sourceRoot: string
  try {
    sourceRoot = await realpath(requestedPath)
    await access(sourceRoot, constants.R_OK | constants.X_OK)
  } catch (error: unknown) {
    throw new InstallerError({
      code: 'SOURCE_NOT_ACCESSIBLE',
      facts: [['Observed', `${requestedPath} could not be resolved and read by the invoking developer.`]],
      retry: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }

  await assertSourceDirectory(sourceRoot)

  const workTreeResult = await runProcess(gitExecutable, ['-C', sourceRoot, 'rev-parse', '--is-inside-work-tree'])
  const topLevelResult = await runProcess(gitExecutable, ['-C', sourceRoot, 'rev-parse', '--show-toplevel'])
  if (
    workTreeResult.exitCode !== 0 ||
    workTreeResult.stdout.trim() !== 'true' ||
    topLevelResult.exitCode !== 0 ||
    topLevelResult.stdout.trim() === ''
  ) {
    throw new InstallerError({
      code: 'SOURCE_NOT_GIT_CHECKOUT',
      facts: [['Observed', `${sourceRoot} did not pass local git rev-parse checks.`]],
      retry: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
  const gitTopLevel = await realpath(topLevelResult.stdout.trim())
  if (gitTopLevel !== sourceRoot) {
    throw new InstallerError({
      code: 'SOURCE_NOT_CHECKOUT_ROOT',
      facts: [
        ['Selected source', sourceRoot],
        ['Checkout root', gitTopLevel],
      ],
      retry: 'qiln up --source <checkout-root> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
  const gitEntryPath = join(sourceRoot, '.git')
  const gitEntry = await lstat(gitEntryPath).catch(() => null)
  if (!gitEntry || gitEntry.isSymbolicLink() || (!gitEntry.isDirectory() && !gitEntry.isFile())) {
    throw new InstallerError({
      code: 'INVALID_GIT_METADATA',
      facts: [['Observed', `${gitEntryPath} is missing, symbolic, or not a normal worktree metadata entry.`]],
      retry: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
  const packageJsonPath = join(sourceRoot, 'package.json')
  let packageMetadata
  try {
    packageMetadata = await lstat(packageJsonPath)
  } catch (error: unknown) {
    throw new InstallerError({
      code: 'INVALID_SOURCE_CHECKOUT',
      facts: [['Observed', `${packageJsonPath} could not be inspected.`]],
      retry: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
  if (
    packageMetadata.isSymbolicLink() ||
    !packageMetadata.isFile() ||
    packageMetadata.size === 0 ||
    packageMetadata.size > MAX_PACKAGE_JSON_BYTES
  ) {
    throw new InstallerError({
      code: 'INVALID_SOURCE_PACKAGE',
      facts: [
        [
          'Observed',
          `${packageJsonPath} must be a non-empty regular file no larger than ${MAX_PACKAGE_JSON_BYTES} bytes.`,
        ],
      ],
      retry: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
  let packageJson: unknown
  try {
    packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as unknown
  } catch (error: unknown) {
    throw new InstallerError({
      code: 'INVALID_SOURCE_PACKAGE',
      facts: [['Observed', `${packageJsonPath} could not be decoded as JSON.`]],
      retry: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
  if (!isRecord(packageJson) || packageJson.name !== 'qiln') {
    throw new InstallerError({
      code: 'SOURCE_NOT_QILN_PACKAGE',
      facts: [['Observed', "package.json must have name='qiln'."]],
      retry: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
  return {
    sourceRoot,
  }
}
