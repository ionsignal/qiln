import { constants } from 'node:fs'
import { access, lstat, readlink, realpath, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { catalog } from '../../diagnostic/catalog'
import { InstallerError, type InstallerErrorCode } from '../../diagnostic/error'
import { inspectChild, openChildDir, readChild, writeChild, type Dir } from '../../state/files'
import { acquireLock, type StateLock } from '../../state/lock'
import { statePath } from '../../state/path'
import { isErrorCode } from '../errors'
import { AWS_SPEC } from '../spec'
import { openAwsRoot, userId } from '../state'
import { hasKeys, isRecord, isTimestamp } from '../types'
import { RELEASE, TOOL_SPEC, type Artifact, type Release, type ReviewedLink, type TargetId } from './spec'

export interface InstallationRecord {
  version: 1
  cliVersion: string
  target: TargetId
  phase: 'installing' | 'ready' | 'failed'
  artifact: Artifact
  startedAt: string
  updatedAt: string
  failureCode: InstallerErrorCode | null
  termination: 'confirmed' | 'unconfirmed'
  cleanup: 'completed' | 'unconfirmed'
}

export interface ReadyInstallation {
  directory: Dir
  record: InstallationRecord
  executable: string
}

function invalid(): never {
  throw new InstallerError({
    code: 'AWS_TOOL_STATE_INVALID',
    retry: 'qiln aws connect',
  })
}

function stateError(error: unknown): InstallerError {
  if (error instanceof InstallerError) {
    return error
  }
  return new InstallerError({
    code: 'AWS_TOOL_STATE_INVALID',
    retry: 'qiln aws connect',
  })
}

function isInstallerCode(value: unknown): value is InstallerErrorCode {
  return typeof value === 'string' && Object.hasOwn(catalog, value)
}

export function contains(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith('../'))
}

export function toolsPath(): string {
  return join(statePath(process.env, 'qiln aws connect'), AWS_SPEC.state.directory, TOOL_SPEC.state.directory)
}

export function location(): string {
  const path = join(toolsPath(), TOOL_SPEC.version, RELEASE.target)
  if (/[\u0000-\u001f\u007f]/.test(path) || /\s/.test(path)) {
    throw new InstallerError({
      code: 'AWS_TOOL_PATH_INVALID',
      facts: [['Observed', 'The configured managed destination contains unsupported characters.']],
      retry: 'qiln aws connect',
    })
  }
  return path
}

export function artifactIdentity(artifact: Artifact): Artifact {
  return {
    url: artifact.url,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    format: artifact.format,
  }
}

function parse(value: unknown): InstallationRecord {
  if (
    !isRecord(value) ||
    !hasKeys(value, [
      'version',
      'cliVersion',
      'target',
      'phase',
      'artifact',
      'startedAt',
      'updatedAt',
      'failureCode',
      'termination',
      'cleanup',
    ]) ||
    value.version !== 1 ||
    value.cliVersion !== TOOL_SPEC.version ||
    value.target !== RELEASE.target ||
    (value.phase !== 'installing' && value.phase !== 'ready' && value.phase !== 'failed') ||
    !isTimestamp(value.startedAt) ||
    !isTimestamp(value.updatedAt) ||
    (value.failureCode !== null && !isInstallerCode(value.failureCode)) ||
    (value.termination !== 'confirmed' && value.termination !== 'unconfirmed') ||
    (value.cleanup !== 'completed' && value.cleanup !== 'unconfirmed')
  ) {
    return invalid()
  }
  const expected = artifactIdentity(RELEASE.artifact)
  const artifact = value.artifact
  if (
    !isRecord(artifact) ||
    !hasKeys(artifact, ['url', 'bytes', 'sha256', 'format']) ||
    !Object.entries(expected).every(([key, entry]) => artifact[key] === entry) ||
    (value.phase === 'failed' ? value.failureCode === null : value.failureCode !== null) ||
    (value.phase === 'ready' && (value.termination !== 'confirmed' || value.cleanup !== 'completed'))
  ) {
    return invalid()
  }
  return {
    version: 1,
    cliVersion: value.cliVersion,
    target: RELEASE.target,
    phase: value.phase,
    artifact: expected,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    failureCode: value.failureCode,
    termination: value.termination,
    cleanup: value.cleanup,
  }
}

export async function open(create = false): Promise<Dir | null> {
  try {
    const aws = await openAwsRoot(create)
    if (!aws) {
      return null
    }
    let directory: Dir
    try {
      directory = await openChildDir(
        aws,
        TOOL_SPEC.state.directory,
        {
          owner: userId(),
          mode: 0o700,
        },
        create,
      )
    } catch (error: unknown) {
      if (!create && isErrorCode(error, 'ENOENT')) {
        return null
      }
      throw error
    }
    for (const name of await directory.list()) {
      if (name !== TOOL_SPEC.version && name !== TOOL_SPEC.state.lock) {
        return invalid()
      }
      const kind = await inspectChild(directory, name, {
        owner: userId(),
        fileMode: 0o600,
        directoryMode: 0o700,
        maxFileSize: 64,
      })
      if ((name === TOOL_SPEC.version) !== (kind === 'directory')) {
        return invalid()
      }
    }
    return directory
  } catch (error: unknown) {
    throw stateError(error)
  }
}

export async function unlocked(directory: Dir): Promise<void> {
  if ((await directory.list()).includes(TOOL_SPEC.state.lock)) {
    throw new InstallerError({
      code: 'AWS_TOOL_LOCKED',
      facts: [['Tool directory', directory.path]],
      retry: 'qiln aws connect',
    })
  }
}

async function versionDirectory(directory: Dir, create: boolean): Promise<Dir | null> {
  let version: Dir
  try {
    version = await openChildDir(
      directory,
      TOOL_SPEC.version,
      {
        owner: userId(),
        mode: 0o700,
      },
      create,
    )
  } catch (error: unknown) {
    if (!create && isErrorCode(error, 'ENOENT')) {
      return null
    }
    throw error
  }
  for (const name of await version.list()) {
    if (name !== RELEASE.target) {
      return invalid()
    }
    const kind = await inspectChild(version, name, {
      owner: userId(),
      directoryMode: 0o700,
    })
    if (kind !== 'directory') {
      return invalid()
    }
  }
  return version
}

function partial(): never {
  throw new InstallerError({
    code: 'AWS_TOOL_PARTIAL',
    facts: [
      ['Target', RELEASE.target],
      ['Installation', location()],
    ],
    retry: 'qiln aws connect',
  })
}

export async function create(directory: Dir): Promise<Dir> {
  try {
    const version = await versionDirectory(directory, true)
    if (!version) {
      return invalid()
    }
    if ((await version.list()).includes(RELEASE.target)) {
      return partial()
    }
    const target = await openChildDir(
      version,
      RELEASE.target,
      {
        owner: userId(),
        mode: 0o700,
      },
      true,
    )
    if ((await target.list()).length !== 0) {
      return partial()
    }
    return target
  } catch (error: unknown) {
    throw stateError(error)
  }
}

export async function write(directory: Dir, record: InstallationRecord): Promise<void> {
  try {
    const validated = parse(record)
    await writeChild(directory, TOOL_SPEC.state.record, Buffer.from(`${JSON.stringify(validated, null, 2)}\n`), 0o600)
  } catch (error: unknown) {
    throw stateError(error)
  }
}

function payloadError(): InstallerError {
  return new InstallerError({
    code: 'AWS_TOOL_PAYLOAD_INVALID',
    retry: 'qiln aws connect',
  })
}

function payloadPath(root: string, path: string, roots: readonly string[]): boolean {
  if (!contains(root, path) || path === root) {
    return false
  }
  const name = relative(root, path).split('/')[0]
  return name !== undefined && roots.includes(name)
}

/**
 * Vendor entries retain their installation modes. Only reviewed links are
 * permitted, and neither lexical nor resolved targets may leave the payload.
 */
export async function tree(root: string, links: readonly ReviewedLink[], roots?: readonly string[]): Promise<void> {
  try {
    const allowedRoots = roots ?? (await readdir(root))
    const reviewed = new Map<string, string>()
    for (const link of links) {
      if (
        isAbsolute(link.path) ||
        isAbsolute(link.to) ||
        !payloadPath(root, resolve(root, link.path), allowedRoots) ||
        !payloadPath(root, resolve(root, link.to), allowedRoots) ||
        reviewed.has(link.path) ||
        relative(root, resolve(root, link.path)) !== link.path
      ) {
        throw payloadError()
      }
      reviewed.set(link.path, resolve(root, link.to))
    }
    const seen = new Set<string>()
    let entries = 0
    const visit = async (path: string): Promise<void> => {
      entries++
      if (entries > TOOL_SPEC.maximumPayloadEntries) {
        throw payloadError()
      }
      const metadata = await lstat(path)
      if (metadata.uid !== userId()) {
        throw payloadError()
      }
      if (metadata.isSymbolicLink()) {
        const name = relative(root, path)
        const expected = reviewed.get(name)
        if (expected === undefined) {
          throw payloadError()
        }
        const destination = resolve(join(path, '..'), await readlink(path))
        if (destination !== expected || !payloadPath(root, destination, allowedRoots)) {
          throw payloadError()
        }
        const resolved = await realpath(path)
        if (!payloadPath(root, resolved, allowedRoots)) {
          throw payloadError()
        }
        seen.add(name)
        return
      }
      if ((!metadata.isFile() && !metadata.isDirectory()) || (metadata.mode & 0o022) !== 0) {
        throw payloadError()
      }
      if (metadata.isDirectory()) {
        for (const name of await readdir(path)) {
          await visit(join(path, name))
        }
      }
    }
    const rootMetadata = await lstat(root)
    if (!rootMetadata.isDirectory() || rootMetadata.uid !== userId() || (rootMetadata.mode & 0o022) !== 0) {
      throw payloadError()
    }
    for (const name of allowedRoots) {
      await visit(join(root, name))
    }
    if (seen.size !== reviewed.size) {
      throw payloadError()
    }
  } catch (error: unknown) {
    if (error instanceof InstallerError) {
      throw error
    }
    throw payloadError()
  }
}

export async function executable(directory: Dir, release: Release): Promise<string> {
  const roots = ['aws-cli', 'bin']
  const names = await directory.list()
  if (
    roots.some(name => !names.includes(name)) ||
    names.some(name => !roots.includes(name) && name !== TOOL_SPEC.state.record && name !== TOOL_SPEC.state.workspace)
  ) {
    throw payloadError()
  }
  await tree(directory.path, release.links, roots)
  const path = resolve(directory.path, release.executable)
  if (!payloadPath(directory.path, path, roots)) {
    throw payloadError()
  }
  try {
    const resolved = await realpath(path)
    const metadata = await stat(resolved)
    if (
      !payloadPath(directory.path, resolved, roots) ||
      !metadata.isFile() ||
      metadata.uid !== userId() ||
      (metadata.mode & 0o111) === 0 ||
      (metadata.mode & 0o022) !== 0
    ) {
      throw payloadError()
    }
    await access(resolved, constants.X_OK)
    return path
  } catch (error: unknown) {
    if (error instanceof InstallerError) {
      throw error
    }
    throw payloadError()
  }
}

export async function read(directory: Dir): Promise<ReadyInstallation | null> {
  try {
    const version = await versionDirectory(directory, false)
    if (!version || !(await version.list()).includes(RELEASE.target)) {
      return null
    }
    const target = await openChildDir(version, RELEASE.target, {
      owner: userId(),
      mode: 0o700,
    })
    const names = await target.list()
    if (!names.includes(TOOL_SPEC.state.record)) {
      return partial()
    }
    const snapshot = await readChild(target, TOOL_SPEC.state.record, {
      owner: userId(),
      mode: 0o600,
      minSize: 1,
      maxSize: TOOL_SPEC.maximumRecordBytes,
    })
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', {
        fatal: true,
      }).decode(snapshot.bytes),
    )
    const record = parse(value)
    if (names.includes(TOOL_SPEC.state.workspace)) {
      const kind = await inspectChild(target, TOOL_SPEC.state.workspace, {
        owner: userId(),
        directoryMode: 0o700,
      })
      if (kind !== 'directory') {
        return invalid()
      }
      return partial()
    }
    if (record.phase !== 'ready') {
      return partial()
    }
    return {
      directory: target,
      record,
      executable: await executable(target, RELEASE),
    }
  } catch (error: unknown) {
    throw stateError(error)
  }
}

export function lock(directory: Dir): Promise<StateLock> {
  return acquireLock(directory, {
    name: TOOL_SPEC.state.lock,
    label: 'AWS managed tools',
    retry: 'qiln aws connect',
    codes: {
      changed: 'AWS_TOOL_LOCK_CHANGED',
      locked: 'AWS_TOOL_LOCKED',
      failed: 'AWS_TOOL_LOCK_FAILED',
    },
  })
}
