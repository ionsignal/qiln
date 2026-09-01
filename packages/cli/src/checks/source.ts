import { constants } from 'node:fs'
import { access, lstat, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { QilnInstallerError } from '../error'
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
    throw new QilnInstallerError({
      code: 'INVALID_SOURCE_CHECKOUT',
      check: 'Qiln source checkout',
      summary: 'The source checkout path could not be inspected.',
      observed: `${path} could not be inspected.`,
      reason: 'The source deployment input must be a readable directory.',
      operatorAction: 'Select the canonical local Qiln Git checkout root with --source.',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
      cause: error,
    })
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new QilnInstallerError({
      code: 'INVALID_SOURCE_CHECKOUT',
      check: 'Qiln source checkout',
      summary: 'The source checkout path is not a directory.',
      observed: `${path} is not a real directory.`,
      reason: 'The installer requires a canonical directory root rather than a symbolic link or file.',
      operatorAction: 'Use the root of a local Qiln Git checkout.',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
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
    throw new QilnInstallerError({
      code: 'SOURCE_NOT_ACCESSIBLE',
      check: 'Qiln source checkout',
      summary: 'The supplied source path is not accessible.',
      observed: `${requestedPath} could not be resolved and read by the invoking developer.`,
      reason: 'Source collection must run entirely as the unprivileged invoking developer.',
      operatorAction: 'Provide a readable local Qiln checkout owned or accessible by the developer.',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
      cause: error,
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
    throw new QilnInstallerError({
      code: 'SOURCE_NOT_GIT_CHECKOUT',
      check: 'Qiln source Git checkout',
      summary: 'The supplied source path is not a valid Git working tree.',
      observed: `${sourceRoot} did not pass local git rev-parse checks.`,
      reason: 'The host checkout is the canonical Git repository for the developer source workflow.',
      operatorAction: 'Pass the root of the canonical local Qiln Git checkout.',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
  const gitTopLevel = await realpath(topLevelResult.stdout.trim())
  if (gitTopLevel !== sourceRoot) {
    throw new QilnInstallerError({
      code: 'SOURCE_NOT_CHECKOUT_ROOT',
      check: 'Qiln source checkout root',
      summary: 'The supplied source path is not the Git checkout root.',
      observed: `Supplied root '${sourceRoot}' resolves to Git top level '${gitTopLevel}'.`,
      reason: 'The managed source manifest must have one deterministic repository-relative root.',
      operatorAction: `Rerun with '--source ${gitTopLevel}'.`,
      rerun: 'qiln up --source <checkout-root> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
  const gitEntryPath = join(sourceRoot, '.git')
  const gitEntry = await lstat(gitEntryPath).catch(() => null)
  if (!gitEntry || gitEntry.isSymbolicLink() || (!gitEntry.isDirectory() && !gitEntry.isFile())) {
    throw new QilnInstallerError({
      code: 'INVALID_GIT_METADATA',
      check: 'Qiln source Git metadata',
      summary: 'The source checkout has unsupported Git metadata.',
      observed: `${gitEntryPath} is missing, symbolic, or not a normal worktree metadata entry.`,
      reason:
        'Qiln supports normal Git checkouts and Git worktrees, while preserving and excluding their .git metadata.',
      operatorAction: 'Repair or recreate the local Git checkout before source deployment.',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
  const packageJsonPath = join(sourceRoot, 'package.json')
  let packageMetadata
  try {
    packageMetadata = await lstat(packageJsonPath)
  } catch (error: unknown) {
    throw new QilnInstallerError({
      code: 'INVALID_SOURCE_CHECKOUT',
      check: 'Qiln package metadata',
      summary: 'The source checkout is missing package.json.',
      observed: `${packageJsonPath} could not be inspected.`,
      reason: 'The deployment source must contain a root package.json file.',
      operatorAction: 'Use a valid local checkout containing package.json.',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
      cause: error,
    })
  }
  if (
    packageMetadata.isSymbolicLink() ||
    !packageMetadata.isFile() ||
    packageMetadata.size === 0 ||
    packageMetadata.size > MAX_PACKAGE_JSON_BYTES
  ) {
    throw new QilnInstallerError({
      code: 'INVALID_SOURCE_PACKAGE',
      check: 'Qiln package metadata',
      summary: 'The source package.json is not a supported regular file.',
      observed: `${packageJsonPath} must be a non-empty regular file no larger than ${MAX_PACKAGE_JSON_BYTES} bytes.`,
      reason: 'The installer must validate a bounded canonical package descriptor.',
      operatorAction: 'Repair the local Qiln checkout before deployment.',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
  let packageJson: unknown
  try {
    packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as unknown
  } catch (error: unknown) {
    throw new QilnInstallerError({
      code: 'INVALID_SOURCE_PACKAGE',
      check: 'Qiln package metadata',
      summary: 'The source package.json is invalid.',
      observed: `${packageJsonPath} could not be decoded as JSON.`,
      reason: 'The deployment source must contain a valid package descriptor.',
      operatorAction: 'Repair package.json in the local checkout before deployment.',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
      cause: error,
    })
  }
  if (!isRecord(packageJson) || packageJson.name !== 'qiln') {
    throw new QilnInstallerError({
      code: 'SOURCE_NOT_QILN_PACKAGE',
      check: 'Qiln package identity',
      summary: 'The supplied checkout does not identify the expected Qiln package descriptor.',
      observed: "package.json must have name='qiln'.",
      reason: 'Qiln must not deploy an unrelated source tree into the orchestrator workspace.',
      operatorAction: 'Pass the root of the intended Qiln repository.',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
  return {
    sourceRoot,
  }
}
