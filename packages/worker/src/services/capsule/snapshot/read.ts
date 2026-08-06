import { createHash } from 'node:crypto'
import {
  AgentSnapshotContentOutputSchema,
  AgentSnapshotManifestEntriesOutputSchema,
  AgentSnapshotManifestRootsOutputSchema,
  AgentSnapshotReadMode,
  CapsuleArtifactEntryType,
  CapsuleSnapshotAgentArtifactContentPolicy,
  MAX_AGENT_SNAPSHOT_ARTIFACT_CONTENT_BYTES,
  type AgentSnapshotArtifactEntry,
  type AgentSnapshotArtifactRoot,
  type AgentSnapshotRead,
  type AgentSnapshotReadOutput,
} from '@qiln/core/server'
import { IncusError } from '../../../errors'
import type { IncusClient } from '../../../incus/client'
import type { CommittedSnapshotArtifacts, CapsuleSnapshotArtifactStore } from './artifact'

const ARTIFACT_READ_TIMEOUT_MS = 30_000

function providerPath(root: AgentSnapshotArtifactRoot, entry: AgentSnapshotArtifactEntry): string {
  if (entry.logicalPath === root.logicalPath) {
    return '/'
  }
  const prefix = root.logicalPath === '/' ? '/' : `${root.logicalPath}/`
  if (!entry.logicalPath.startsWith(prefix)) {
    throw new IncusError('Committed artifact entry is outside its manifest root.', 'CONFLICT')
  }
  return `/${entry.logicalPath.slice(prefix.length)}`
}

/**
 * Reads only immutable artifact evidence from exact committed snapshot storage.
 *
 * The service never reads an editable branch, live instance rootfs, arbitrary
 * volume, provider-discovered snapshot, or host filesystem path.
 */
export class CapsuleSnapshotReadService {
  constructor(
    private readonly artifacts: CapsuleSnapshotArtifactStore,
    private readonly incus: IncusClient,
  ) {}

  public async read(ownerId: string, capsuleId: string, input: AgentSnapshotRead): Promise<AgentSnapshotReadOutput> {
    const artifacts = await this.artifacts.load(ownerId, capsuleId, input.snapshotId)
    if (input.mode === AgentSnapshotReadMode.MANIFEST) {
      return this.manifest(artifacts, input)
    }
    if (
      artifacts.agentArtifactContentPolicy !== CapsuleSnapshotAgentArtifactContentPolicy.OWNER_AUTHORIZED_UNREVIEWED
    ) {
      throw new IncusError('Artifact content is not approved for this committed snapshot.', 'FORBIDDEN')
    }
    return await this.content(artifacts, input.rootId, input.logicalPath)
  }

  private manifest(artifacts: CommittedSnapshotArtifacts, input: Extract<AgentSnapshotRead, { mode: 'manifest' }>) {
    if (input.rootId === undefined) {
      const roots = artifacts.manifest.roots.filter(
        root => input.afterRootId === undefined || root.id > input.afterRootId,
      )
      const page = roots.slice(0, input.limit)
      const hasNext = roots.length > page.length

      return AgentSnapshotManifestRootsOutputSchema.parse({
        mode: AgentSnapshotReadMode.MANIFEST,
        view: 'roots',
        snapshotId: artifacts.snapshotId,
        roots: page,
        nextAfterRootId: hasNext ? (page.at(-1)?.id ?? null) : null,
      })
    }
    const root = artifacts.manifest.roots.find(candidate => candidate.id === input.rootId)
    if (!root) {
      throw new IncusError('Committed artifact root was not found.', 'NOT_FOUND')
    }
    const entries = artifacts.manifest.entries.filter(
      entry =>
        entry.rootId === root.id &&
        (input.afterLogicalPath === undefined || entry.logicalPath > input.afterLogicalPath),
    )
    const page = entries.slice(0, input.limit)
    const hasNext = entries.length > page.length
    return AgentSnapshotManifestEntriesOutputSchema.parse({
      mode: AgentSnapshotReadMode.MANIFEST,
      view: 'entries',
      snapshotId: artifacts.snapshotId,
      root,
      entries: page,
      nextAfterLogicalPath: hasNext ? (page.at(-1)?.logicalPath ?? null) : null,
    })
  }

  private async content(
    artifacts: CommittedSnapshotArtifacts,
    rootId: string,
    logicalPath: string,
  ): Promise<AgentSnapshotReadOutput> {
    const root = artifacts.manifest.roots.find(candidate => candidate.id === rootId)
    if (!root) {
      throw new IncusError('Committed artifact root was not found.', 'NOT_FOUND')
    }
    const entry = artifacts.manifest.entries.find(
      candidate => candidate.rootId === root.id && candidate.logicalPath === logicalPath,
    )
    if (!entry || entry.type !== CapsuleArtifactEntryType.FILE) {
      throw new IncusError('Committed regular-file artifact was not found.', 'NOT_FOUND')
    }
    try {
      const reference = await this.artifacts.reference(artifacts, root.id)
      const controller = new AbortController()
      const timeout = setTimeout(() => {
        controller.abort()
      }, ARTIFACT_READ_TIMEOUT_MS)
      try {
        const snapshot = this.incus
          .project(reference.project)
          .storage.files.snapshot(reference.pool, reference.sourceVolume, reference.snapshotName)
        const providerEntry = await snapshot.get(providerPath(root, entry), {
          signal: controller.signal,
        })
        if (providerEntry.type !== 'file') {
          throw new IncusError('Committed artifact storage no longer contains the expected regular file.', 'CONFLICT')
        }
        const content = await this.text(providerEntry.stream, controller.signal, entry.size, entry.contentDigest)
        return AgentSnapshotContentOutputSchema.parse({
          mode: AgentSnapshotReadMode.CONTENT,
          snapshotId: artifacts.snapshotId,
          rootId: root.id,
          logicalPath: entry.logicalPath,
          agentArtifactContentPolicy: CapsuleSnapshotAgentArtifactContentPolicy.OWNER_AUTHORIZED_UNREVIEWED,
          encoding: 'utf-8',
          size: entry.size,
          contentDigest: entry.contentDigest,
          content,
        })
      } finally {
        clearTimeout(timeout)
        if (!controller.signal.aborted) {
          controller.abort()
        }
      }
    } catch {
      throw new IncusError('Committed artifact content is unavailable.', 'CONFLICT')
    }
  }

  private async text(
    stream: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    expectedSize: number,
    expectedDigest: string,
  ): Promise<string> {
    const reader = stream.getReader()
    const decoder = new TextDecoder('utf-8', {
      fatal: true,
    })
    const hash = createHash('sha256')
    let size = 0
    let content = ''
    let completed = false
    try {
      while (true) {
        if (signal.aborted) {
          throw new IncusError('Committed artifact content read timed out.', 'TRANSPORT_ERROR')
        }
        const result = await reader.read()
        if (result.done) {
          completed = true
          break
        }
        const nextSize = size + result.value.byteLength
        if (
          !Number.isSafeInteger(nextSize) ||
          nextSize > MAX_AGENT_SNAPSHOT_ARTIFACT_CONTENT_BYTES ||
          nextSize > expectedSize
        ) {
          throw new IncusError('Committed artifact content exceeds its approved byte limit.', 'CONFLICT')
        }
        size = nextSize
        hash.update(result.value)
        content += decoder.decode(result.value, {
          stream: true,
        })
      }
      content += decoder.decode()
      if (size !== expectedSize || `sha256:${hash.digest('hex')}` !== expectedDigest) {
        throw new IncusError('Committed artifact content no longer matches immutable manifest evidence.', 'CONFLICT')
      }
      return content
    } finally {
      if (!completed) {
        await reader.cancel().catch(() => undefined)
      }
      reader.releaseLock()
    }
  }
}
