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
import type {
  IncusStorageFilesClient,
  IncusStorageReadEntry,
  IncusStorageSnapshotFilesClient,
} from '../../../../incus/client/storage/files'
import type { CaptureRootPlan } from './types'
import type { ReadableStreamReadResult } from 'node:stream/web'

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
  deadlineAt: number
  entryCount: number
  totalBytes: number
  entries: CapsuleArtifactEntry[]
  visitedRequiredPaths: Set<string>
  visitedRequiredExclusions: Set<string>
}

interface RootCollectionContext {
  operationId: string
  root: CapsuleSnapshotCapturePolicyPin['artifactRoots'][number]
  snapshot: IncusStorageSnapshotFilesClient
  limits: CaptureCollectionLimits
  state: CollectionState
  signal: AbortSignal
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

function collectionTimeoutError(operationId: string, timeoutMs: number): IncusError {
  return new IncusError('Experimental Snapshot Capture artifact collection timed out.', 'TRANSPORT_ERROR', {
    operationId,
    timeoutMs,
  })
}

function throwIfCollectionExpired(context: RootCollectionContext): void {
  if (context.signal.aborted || Date.now() >= context.state.deadlineAt) {
    const reason = context.signal.reason
    if (reason instanceof IncusError) {
      throw reason
    }
    throw collectionTimeoutError(context.operationId, context.limits.timeoutMs)
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

function recordRequiredPath(context: RootCollectionContext, logicalPath: string, entry: IncusStorageReadEntry): void {
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
  entry: IncusStorageReadEntry,
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
  entry: Extract<IncusStorageReadEntry, { type: 'directory' }>,
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

async function createFileEntry(
  context: RootCollectionContext,
  logicalPath: string,
  entry: Extract<IncusStorageReadEntry, { type: 'file' }>,
): Promise<CapsuleArtifactEntry> {
  const hash = createHash('sha256')
  const reader = entry.stream.getReader()
  let size = 0
  let reachedEof = false
  try {
    while (true) {
      throwIfCollectionExpired(context)
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await reader.read()
      } catch (error: unknown) {
        if (context.signal.aborted || Date.now() >= context.state.deadlineAt) {
          throw collectionTimeoutError(context.operationId, context.limits.timeoutMs)
        }
        throw error
      }
      if (result.done) {
        reachedEof = true
        break
      }
      const chunk = result.value
      const nextSize = size + chunk.byteLength
      if (!Number.isSafeInteger(nextSize) || nextSize > context.limits.maxFileSizeBytes) {
        throw new IncusError('Experimental Snapshot Capture file exceeds the configured file-size limit.', 'CONFLICT', {
          operationId: context.operationId,
          artifactRootId: context.root.id,
          logicalPath,
          size: nextSize,
          maxFileSizeBytes: context.limits.maxFileSizeBytes,
        })
      }
      const nextTotalBytes = context.state.totalBytes + chunk.byteLength
      if (!Number.isSafeInteger(nextTotalBytes) || nextTotalBytes > context.limits.maxTotalBytes) {
        throw new IncusError('Experimental Snapshot Capture exceeded its total hashed-byte limit.', 'CONFLICT', {
          operationId: context.operationId,
          artifactRootId: context.root.id,
          logicalPath,
          totalBytes: nextTotalBytes,
          maxTotalBytes: context.limits.maxTotalBytes,
        })
      }
      size = nextSize
      context.state.totalBytes = nextTotalBytes
      hash.update(chunk)
    }
  } finally {
    if (!reachedEof) {
      try {
        await reader.cancel()
      } catch {
        // The response stream may already be aborted by the collection deadline.
      }
    }
    reader.releaseLock()
  }
  return {
    size,
    rootId: context.root.id,
    logicalPath,
    type: CapsuleArtifactEntryType.FILE,
    mode: entry.metadata.mode,
    uid: entry.metadata.uid,
    gid: entry.metadata.gid,
    modifiedAt: toCanonicalCapsuleArtifactTimestamp(entry.metadata.modifiedAt),
    contentDigest: `sha256:${hash.digest('hex')}`,
  }
}

/**
 * Collects canonical regular-file and directory evidence from exact retained
 * custom-volume snapshots.
 *
 * Every snapshot handle is created from the deterministic provider identity
 * accepted into the operation-scoped capture resource ledger. Collection does
 * not list, discover, infer, or adopt provider snapshots.
 *
 * File content is hashed incrementally. A single collection-wide abort signal
 * bounds pending REST requests and active response-stream consumption.
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
    const policyRootsById = new Map(input.policy.artifactRoots.map(root => [root.id, root] as const))
    const plansByRootId = new Map<string, CaptureRootPlan>()
    for (const plan of input.roots) {
      if (plansByRootId.has(plan.artifactRootId)) {
        throw new IncusError('Snapshot Capture collection plan contains a duplicate artifact root.', 'CONFLICT', {
          operationId: input.operationId,
          artifactRootId: plan.artifactRootId,
        })
      }
      const root = policyRootsById.get(plan.artifactRootId)
      if (!root || root.blueprintVolumeName !== plan.blueprintVolumeName) {
        throw new IncusError(
          'Snapshot Capture collection plan contains an unknown or contradictory root.',
          'CONFLICT',
          {
            operationId: input.operationId,
            artifactRootId: plan.artifactRootId,
            blueprintVolumeName: plan.blueprintVolumeName,
            expectedBlueprintVolumeName: root?.blueprintVolumeName ?? null,
          },
        )
      }
      plansByRootId.set(plan.artifactRootId, plan)
    }
    for (const root of input.policy.artifactRoots) {
      if (!plansByRootId.has(root.id)) {
        throw new IncusError(`Snapshot Capture collection plan is missing artifact root '${root.id}'.`, 'CONFLICT', {
          operationId: input.operationId,
          artifactRootId: root.id,
          blueprintVolumeName: root.blueprintVolumeName,
        })
      }
    }
    const startedAt = Date.now()
    const controller = new AbortController()
    const timeoutError = collectionTimeoutError(input.operationId, limits.timeoutMs)
    const timeout = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort(timeoutError)
      }
    }, limits.timeoutMs)
    const state: CollectionState = {
      startedAt,
      deadlineAt: startedAt + limits.timeoutMs,
      entryCount: 0,
      totalBytes: 0,
      entries: [],
      visitedRequiredPaths: new Set<string>(),
      visitedRequiredExclusions: new Set<string>(),
    }
    try {
      const roots = [...input.policy.artifactRoots].sort((left, right) => compareStableString(left.id, right.id))
      for (const root of roots) {
        const plan = plansByRootId.get(root.id)!
        const snapshot = input.files.snapshot(plan.pool, plan.sourceVolume, plan.snapshotName)
        const externalBoundaries = new Set(
          input.policy.externalMounts.filter(mount => mount.artifactRootId === root.id).map(mount => mount.logicalPath),
        )
        await this.walk(
          {
            operationId: input.operationId,
            root,
            snapshot,
            limits,
            state,
            signal: controller.signal,
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
        limitations: [CapsuleSnapshotLimitation.ARTIFACT_SECRET_REVIEW_OMITTED],
        entryCount: state.entryCount,
        totalBytes: state.totalBytes,
      }
    } finally {
      clearTimeout(timeout)
      if (!controller.signal.aborted) {
        controller.abort()
      }
    }
  }

  private async walk(
    context: RootCollectionContext,
    internalPath: string,
    logicalPath: string,
    depth: number,
  ): Promise<void> {
    throwIfCollectionExpired(context)
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
    let entry: IncusStorageReadEntry
    try {
      entry = await context.snapshot.get(internalPath, {
        signal: context.signal,
      })
    } catch (error: unknown) {
      if (context.signal.aborted || Date.now() >= context.state.deadlineAt) {
        throw collectionTimeoutError(context.operationId, context.limits.timeoutMs)
      }
      throw error
    }
    recordRequiredPath(context, logicalPath, entry)
    const exclusion = exclusionForPath(context, logicalPath)
    if (exclusion) {
      recordRequiredExclusion(context, logicalPath, entry)
      if (entry.type === 'file') {
        try {
          await entry.stream.cancel()
        } catch {
          // The excluded file body is intentionally not consumed.
        }
      }
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
      context.state.entries.push(await createFileEntry(context, logicalPath, entry))
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
