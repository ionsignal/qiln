import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Stats } from 'node:fs'
import { checkCancellation } from '../terminal/prompts'
import { refuse } from './errors'
import { listSource } from './git'
import { exclusionOf } from './policy'
import { MIB, SOURCE_SPEC, type ExclusionReason } from './spec'

const { limits } = SOURCE_SPEC
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/

export interface SourceFile {
  path: string
  size: number
  signature: string
}

export interface Exclusion {
  reason: ExclusionReason
  count: number
}

/**
 * One scan of the working tree. A comparison of two scans detects change; it
 * does not make the capture an atomic snapshot.
 */
export interface Selection {
  root: string
  files: SourceFile[]
  unpackedBytes: number
  excluded: Exclusion[]
  trackedExcluded: {
    total: number
    names: string[]
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/**
 * Null means the entry is absent, which is how a deleted tracked file looks.
 */
async function inspect(fullPath: string, path: string): Promise<Stats | null> {
  try {
    return await lstat(fullPath)
  } catch (error: unknown) {
    if (isMissing(error)) {
      return null
    }
    throw refuse('A selected path could not be inspected.', path)
  }
}

function requireSafePath(path: string): void {
  if (UNSAFE_CHARACTERS.test(path)) {
    throw refuse('A selected path contains control characters.')
  }
  if (path.endsWith('/')) {
    throw refuse('A nested Git repository or directory was found among the selected paths.', path)
  }
  if (path.startsWith('/') || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw refuse('A selected path is not a normal relative path.', path)
  }
}

async function directoryPresent(root: string, relative: string): Promise<boolean> {
  const stats = await inspect(join(root, relative), relative)
  if (stats === null) {
    return false
  }
  if (!stats.isDirectory()) {
    throw refuse('A parent of a selected path is not a real directory.', relative)
  }
  if ((await inspect(join(root, relative, '.git'), relative)) !== null) {
    throw refuse('A nested Git repository was found.', relative)
  }
  return true
}

/**
 * Each distinct ancestor is inspected once per scan. False means an ancestor is
 * gone, so the file is gone too.
 */
async function ancestorsPresent(root: string, path: string, checked: Map<string, boolean>): Promise<boolean> {
  let current = ''
  for (const part of path.split('/').slice(0, -1)) {
    current = current === '' ? part : `${current}/${part}`
    let present = checked.get(current)
    if (present === undefined) {
      present = await directoryPresent(root, current)
      checked.set(current, present)
    }
    if (!present) {
      return false
    }
  }
  return true
}

function signatureOf(stats: Stats): string {
  return [stats.dev, stats.ino, stats.size, stats.mode, stats.uid, stats.gid, stats.mtimeMs, stats.ctimeMs].join(':')
}

/**
 * Scans the Git checkout containing `directory` and admits ordinary regular
 * files only. Anything else that would be selected is refused rather than
 * skipped, so the package never silently differs from what the developer sees.
 * Parent checks are not race-proof containment.
 */
export async function selectSource(directory: string, signal: AbortSignal): Promise<Selection> {
  const listing = await listSource(directory, signal)
  const { root } = listing
  const excludedCounts = new Map<ExclusionReason, number>()
  const trackedExcluded = { total: 0, names: [] as string[] }
  const checkedDirectories = new Map<string, boolean>()
  const files: SourceFile[] = []
  let unpackedBytes = 0
  const entries = [
    ...listing.tracked.map(path => ({ path, tracked: true })),
    ...listing.untracked.map(path => ({ path, tracked: false })),
  ]
  for (const { path, tracked } of entries) {
    checkCancellation(signal)
    const reason = exclusionOf(path)
    if (reason !== null) {
      excludedCounts.set(reason, (excludedCounts.get(reason) ?? 0) + 1)
      if (tracked) {
        trackedExcluded.total += 1
        if (trackedExcluded.names.length < SOURCE_SPEC.listedExclusions) {
          trackedExcluded.names.push(path)
        }
      }
      continue
    }
    requireSafePath(path)
    if (!(await ancestorsPresent(root, path, checkedDirectories))) {
      continue
    }
    const stats = await inspect(join(root, path), path)
    if (stats === null) {
      continue
    }
    if (!stats.isFile()) {
      throw refuse(
        'Selected paths must be regular files; symbolic links, directories, submodules, and special files are refused.',
        path,
      )
    }
    if (stats.nlink > 1) {
      throw refuse('A selected file has more than one hard link.', path)
    }
    if ((stats.mode & 0o7000) !== 0) {
      throw refuse('A selected file has setuid, setgid, or sticky mode bits.', path)
    }
    if (stats.size > limits.fileBytes) {
      throw refuse(`A selected file exceeds ${limits.fileBytes / MIB} MiB.`, path)
    }
    if (files.length >= limits.files) {
      throw refuse(`More than ${limits.files} files were selected.`)
    }
    unpackedBytes += stats.size
    if (unpackedBytes > limits.unpackedBytes) {
      throw refuse(`The selected files exceed ${limits.unpackedBytes / MIB} MiB unpacked.`)
    }
    files.push({
      path,
      size: stats.size,
      signature: signatureOf(stats),
    })
  }
  if (files.length === 0) {
    throw refuse('No files were selected.')
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return {
    root,
    files,
    unpackedBytes,
    excluded: [...excludedCounts]
      .map(([reason, count]): Exclusion => ({ reason, count }))
      .sort((left, right) => left.reason.localeCompare(right.reason)),
    trackedExcluded,
  }
}

/**
 * Same files with the same metadata. Any difference means the tree changed
 * between two scans.
 */
export function isSameSelection(before: Selection, after: Selection): boolean {
  return (
    before.root === after.root &&
    before.files.length === after.files.length &&
    before.files.every((file, index) => {
      const other = after.files[index]
      return other !== undefined && file.path === other.path && file.signature === other.signature
    })
  )
}
