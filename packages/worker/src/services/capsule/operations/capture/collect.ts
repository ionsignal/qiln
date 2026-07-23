import { createHash } from 'node:crypto'
import {
  CapsuleArtifactEntryType,
  CapsuleArtifactManifestSchema,
  CapsuleSnapshotLimitation,
  digestCapsuleArtifactManifest,
  normalizeCapsuleArtifactManifest,
  toCanonicalCapsuleArtifactTimestamp,
  type CapsuleArtifactEntry,
  type CapsuleArtifactManifest,
  type CapsuleArtifactManifestDigest,
  type CapsuleSnapshotCapturePolicyPin,
  type CapsuleSnapshotLimitationValue,
} from '@qiln/core/server'
import { IncusError } from '../../../../errors'
import type { IncusStorageFilesClient, IncusStorageFileEntry } from '../../../../incus/client/storage/files'
import type { CaptureRootPlan } from './types'

const DEFAULT_MAX_ENTRIES = 25_000
const DEFAULT_MAX_FILE_SIZE_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
const DEFAULT_MAX_DEPTH = 128
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000

export interface CaptureCollectionLimits {
  maxEntries: number
  maxFileSizeBytes: number
  maxTotalBytes: number
  maxDepth: number
  timeoutMs: number
}

export interface CaptureCollectionInput {
  operationId: string
  policy: CapsuleSnapshotCapturePolicyPin
  roots: readonly CaptureRootPlan[]
  files: IncusStorageFilesClient
  limits?: Partial<CaptureCollectionLimits>
}

export interface CaptureCollectionResult {
  manifest: CapsuleArtifactManifest
  digest: CapsuleArtifactManifestDigest
  limitations: readonly CapsuleSnapshotLimitationValue[]
  entryCount: number
  totalBytes: number
}

interface CollectionState {
  startedAt: number
  entryCount: number
  totalBytes: number
  entries: CapsuleArtifactEntry[]
  visitedRequiredPaths: Set<string>
  visitedRequiredExclusions: Set<string>
}

interface RootCollectionContext {
  operationId: string
  policy: CapsuleSnapshotCapturePolicyPin
  root: CapsuleSnapshotCapturePolicyPin['artifactRoots'][number]
  plan: CaptureRootPlan
  files: IncusStorageFilesClient
  limits: CaptureCollectionLimits
  state: CollectionState
  externalBoundaries: Set<string>
}

function compareStableString(left: string, right: string): number {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}

function resolveLimits(value: Partial<CaptureCollectionLimits> | undefined): CaptureCollectionLimits {
  const limits: CaptureCollectionLimits = {
    maxEntries: value?.maxEntries ?? DEFAULT_MAX_ENTRIES,
    maxFileSizeBytes: value?.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES,
    maxTotalBytes: value?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    maxDepth: value?.maxDepth ?? DEFAULT_MAX_DEPTH,
    timeoutMs: value?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  for (const [key, limit] of Object.entries(limits)) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError(`Snapshot Capture collection limit '${key}' must be a positive safe integer.`)
    }
  }
  return limits
}

function logicalChildPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`
}

function internalChildPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`
}

function relativePath(logicalPath: string, rootPath: string): string {
  if (logicalPath === rootPath) {
    return '.'
  }

  return logicalPath.slice(rootPath === '/' ? 1 : rootPath.length + 1)
}

function assertWithinDeadline(context: RootCollectionContext): void {
  if (Date.now() - context.state.startedAt > context.limits.timeoutMs) {
    throw new IncusError('Experimental Snapshot Capture artifact collection timed out.', 'TRANSPORT_ERROR', {
      operationId: context.operationId,
      timeoutMs: context.limits.timeoutMs,
    })
  }
}

function assertEntryCapacity(context: RootCollectionContext): void {
  if (context.state.entryCount >= context.limits.maxEntries) {
    throw new IncusError('Experimental Snapshot Capture exceeded its artifact entry limit.', 'VALIDATION_ERROR', {
      operationId: context.operationId,
      maxEntries: context.limits.maxEntries,
    })
  }
}

function containsGitAdministrativeSegment(path: string): boolean {
  return path
    .split('/')
    .filter(Boolean)
    .some(segment => segment === '.git')
}

function exclusionForPath(
  context: RootCollectionContext,
  logicalPath: string,
): (typeof context.root.exclusions)[number] | null {
  const relative = relativePath(logicalPath, context.root.logicalPath)
  if (relative === '.') {
    return null
  }
  return (
    context.root.exclusions.find(
      exclusion => relative === exclusion.path || relative.startsWith(`${exclusion.path}/`),
    ) ?? null
  )
}

function requiredPathIdentity(rootId: string, path: string): string {
  return `${rootId}\u0000${path}`
}

function recordRequiredPath(context: RootCollectionContext, logicalPath: string, entry: IncusStorageFileEntry): void {
  const relative = relativePath(logicalPath, context.root.logicalPath)
  if (relative === '.') {
    return
  }
  const required = context.root.requiredPaths.find(candidate => candidate.path === relative)
  if (!required) {
    return
  }
  if (entry.type !== required.type) {
    throw new IncusError('Snapshot Capture required artifact path has the wrong filesystem type.', 'CONFLICT', {
      operationId: context.operationId,
      artifactRootId: context.root.id,
      logicalPath,
      requiredType: required.type,
      actualType: entry.type,
    })
  }
  context.state.visitedRequiredPaths.add(requiredPathIdentity(context.root.id, required.path))
}

function recordRequiredExclusion(
  context: RootCollectionContext,
  logicalPath: string,
  entry: IncusStorageFileEntry,
): void {
  const relative = relativePath(logicalPath, context.root.logicalPath)
  const exclusion = context.root.exclusions.find(candidate => candidate.path === relative)
  if (!exclusion || !exclusion.required) {
    return
  }
  if (entry.type !== exclusion.type) {
    throw new IncusError('Snapshot Capture required exclusion has the wrong filesystem type.', 'CONFLICT', {
      operationId: context.operationId,
      artifactRootId: context.root.id,
      logicalPath,
      requiredType: exclusion.type,
      actualType: entry.type,
    })
  }
  context.state.visitedRequiredExclusions.add(requiredPathIdentity(context.root.id, exclusion.path))
}

function createDirectoryEntry(
  context: RootCollectionContext,
  logicalPath: string,
  entry: Extract<IncusStorageFileEntry, { type: 'directory' }>,
): CapsuleArtifactEntry {
  return {
    rootId: context.root.id,
    logicalPath,
    type: CapsuleArtifactEntryType.DIRECTORY,
    mode: entry.metadata.mode,
    uid: entry.metadata.uid,
    gid: entry.metadata.gid,
    modifiedAt: toCanonicalCapsuleArtifactTimestamp(entry.metadata.modifiedAt),
  }
}

function createFileEntry(
  context: RootCollectionContext,
  logicalPath: string,
  entry: Extract<IncusStorageFileEntry, { type: 'file' }>,
): CapsuleArtifactEntry {
  if (entry.data.byteLength > context.limits.maxFileSizeBytes) {
    throw new IncusError('Experimental Snapshot Capture file exceeds the configured file-size limit.', 'CONFLICT', {
      operationId: context.operationId,
      artifactRootId: context.root.id,
      logicalPath,
      size: entry.data.byteLength,
      maxFileSizeBytes: context.limits.maxFileSizeBytes,
    })
  }
  const nextTotalBytes = context.state.totalBytes + entry.data.byteLength
  if (!Number.isSafeInteger(nextTotalBytes) || nextTotalBytes > context.limits.maxTotalBytes) {
    throw new IncusError('Experimental Snapshot Capture exceeded its total hashed-byte limit.', 'CONFLICT', {
      operationId: context.operationId,
      artifactRootId: context.root.id,
      logicalPath,
      totalBytes: nextTotalBytes,
      maxTotalBytes: context.limits.maxTotalBytes,
    })
  }
  context.state.totalBytes = nextTotalBytes
  return {
    rootId: context.root.id,
    logicalPath,
    type: CapsuleArtifactEntryType.FILE,
    mode: entry.metadata.mode,
    uid: entry.metadata.uid,
    gid: entry.metadata.gid,
    modifiedAt: toCanonicalCapsuleArtifactTimestamp(entry.metadata.modifiedAt),
    size: entry.data.byteLength,
    contentDigest: `sha256:${createHash('sha256').update(entry.data).digest('hex')}`,
  }
}

/**
 * Collects basic regular-file and directory evidence from the source custom
 * volume after a retained provider snapshot has been created.
 *
 * TODO(snapshot-capture): Collect from the retained provider snapshot or from a
 * temporary clone of that snapshot. Source-volume collection is allowed only
 * for experimental, non-fork-ready captures.
 *
 * TODO(snapshot-capture): Replace in-memory file reads with bounded streaming
 * hashing before increasing experimental collection limits.
 */
export class CaptureCollector {
  public async collect(input: CaptureCollectionInput): Promise<CaptureCollectionResult> {
    const limits = resolveLimits(input.limits)
    if (input.roots.length !== input.policy.artifactRoots.length) {
      throw new IncusError('Snapshot Capture collection plan does not cover every policy artifact root.', 'CONFLICT', {
        operationId: input.operationId,
        plannedRootCount: input.roots.length,
        policyRootCount: input.policy.artifactRoots.length,
      })
    }
    const state: CollectionState = {
      startedAt: Date.now(),
      entryCount: 0,
      totalBytes: 0,
      entries: [],
      visitedRequiredPaths: new Set<string>(),
      visitedRequiredExclusions: new Set<string>(),
    }
    const roots = [...input.policy.artifactRoots].sort((left, right) => compareStableString(left.id, right.id))
    for (const root of roots) {
      const plan = input.roots.find(candidate => candidate.artifactRootId === root.id)
      if (!plan || plan.blueprintVolumeName !== root.blueprintVolumeName) {
        throw new IncusError(`Snapshot Capture collection plan is missing artifact root '${root.id}'.`, 'CONFLICT', {
          operationId: input.operationId,
          artifactRootId: root.id,
          blueprintVolumeName: root.blueprintVolumeName,
        })
      }
      const externalBoundaries = new Set(
        input.policy.externalMounts.filter(mount => mount.artifactRootId === root.id).map(mount => mount.logicalPath),
      )
      await this.walk(
        {
          operationId: input.operationId,
          policy: input.policy,
          root,
          plan,
          files: input.files,
          limits,
          state,
          externalBoundaries,
        },
        '/',
        root.logicalPath,
        0,
      )
    }

    this.assertRequiredEvidence(input.operationId, input.policy, state)

    const rawManifest = {
      schemaVersion: 1,
      roots: roots.map(root => ({
        id: root.id,
        logicalPath: root.logicalPath,
      })),
      entries: state.entries,
    }
    const parsedManifest = CapsuleArtifactManifestSchema.safeParse(rawManifest)
    if (!parsedManifest.success) {
      throw new IncusError(
        'Experimental Snapshot Capture produced an invalid artifact manifest.',
        'VALIDATION_ERROR',
        parsedManifest.error,
      )
    }
    const manifest = normalizeCapsuleArtifactManifest(parsedManifest.data)
    return {
      manifest,
      digest: digestCapsuleArtifactManifest(manifest),
      limitations: [
        CapsuleSnapshotLimitation.SOURCE_VOLUME_COLLECTION,
        CapsuleSnapshotLimitation.SECRET_POLICY_UNVERIFIED,
      ],
      entryCount: state.entryCount,
      totalBytes: state.totalBytes,
    }
  }

  private async walk(
    context: RootCollectionContext,
    internalPath: string,
    logicalPath: string,
    depth: number,
  ): Promise<void> {
    assertWithinDeadline(context)

    if (depth > context.limits.maxDepth) {
      throw new IncusError('Experimental Snapshot Capture exceeded its directory recursion limit.', 'CONFLICT', {
        operationId: context.operationId,
        artifactRootId: context.root.id,
        logicalPath,
        maxDepth: context.limits.maxDepth,
      })
    }
    if (context.externalBoundaries.has(logicalPath)) {
      return
    }
    if (containsGitAdministrativeSegment(logicalPath)) {
      return
    }
    const entry = await context.files.entry(context.plan.pool, context.plan.sourceVolume, internalPath)
    recordRequiredPath(context, logicalPath, entry)
    const exclusion = exclusionForPath(context, logicalPath)
    if (exclusion) {
      recordRequiredExclusion(context, logicalPath, entry)
      return
    }
    if (entry.type === 'unsupported') {
      throw new IncusError('Snapshot Capture encountered an unsupported filesystem entry.', 'CONFLICT', {
        operationId: context.operationId,
        artifactRootId: context.root.id,
        logicalPath,
        providerType: entry.providerType,
      })
    }

    assertEntryCapacity(context)

    context.state.entryCount++
    if (entry.type === 'file') {
      context.state.entries.push(createFileEntry(context, logicalPath, entry))
      return
    }
    context.state.entries.push(createDirectoryEntry(context, logicalPath, entry))
    for (const name of [...entry.entries].sort(compareStableString)) {
      await this.walk(context, internalChildPath(internalPath, name), logicalChildPath(logicalPath, name), depth + 1)
    }
  }

  private assertRequiredEvidence(
    operationId: string,
    policy: CapsuleSnapshotCapturePolicyPin,
    state: CollectionState,
  ): void {
    for (const root of policy.artifactRoots) {
      for (const required of root.requiredPaths) {
        const identity = requiredPathIdentity(root.id, required.path)
        if (!state.visitedRequiredPaths.has(identity)) {
          throw new IncusError('Snapshot Capture did not collect a required artifact path.', 'CONFLICT', {
            operationId,
            artifactRootId: root.id,
            requiredPath: required.path,
            requiredType: required.type,
          })
        }
      }
      for (const exclusion of root.exclusions) {
        if (!exclusion.required) {
          continue
        }
        const identity = requiredPathIdentity(root.id, exclusion.path)
        if (!state.visitedRequiredExclusions.has(identity)) {
          throw new IncusError('Snapshot Capture did not observe a required artifact exclusion.', 'CONFLICT', {
            operationId,
            artifactRootId: root.id,
            exclusionPath: exclusion.path,
            exclusionType: exclusion.type,
          })
        }
      }
    }
  }
}
