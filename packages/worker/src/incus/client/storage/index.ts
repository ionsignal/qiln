import { z } from 'zod'
import { IncusError } from '../../../errors'
import {
  IncusVolumeCreatePayloadSchema,
  IncusVolumeClonePayloadSchema,
  type IncusVolumeCreatePayload,
  type IncusVolumeClonePayload,
} from '../schemas/storage'
import { IncusStorageFilesClient } from './files'
import { IncusStorageSnapshotsClient } from './snapshots'
import type { IIncusTransport } from '../types'

/**
 * Interfaces with the Incus Storage API to handle ZFS volume orchestration.
 *
 * Snapshot Capture must read the exact persisted snapshot identity through
 * `files`, using `<source-volume>/<snapshot-name>` rather than provider
 * discovery.
 */
export class IncusStorageClient {
  public readonly files: IncusStorageFilesClient
  public readonly snapshots: IncusStorageSnapshotsClient

  constructor(private readonly transport: IIncusTransport) {
    this.files = new IncusStorageFilesClient(this.transport)
    this.snapshots = new IncusStorageSnapshotsClient(this.transport)
  }

  public async create(pool: string, name: string, config?: Record<string, string>): Promise<void> {
    const rawPayload: IncusVolumeCreatePayload = {
      name,
      type: 'custom',
      content_type: 'filesystem',
      config,
    }
    const parsed = IncusVolumeCreatePayloadSchema.safeParse(rawPayload)
    if (!parsed.success) {
      throw new IncusError('Invalid Incus Volume Create Payload', 'VALIDATION_ERROR', z.treeifyError(parsed.error))
    }
    await this.transport.operation(`/storage-pools/${encodeURIComponent(pool)}/volumes/custom`, 'POST', {
      body: parsed.data,
    })
  }

  public async clone(
    pool: string,
    volume: string,
    name: string,
    config?: Record<string, string>,
    sourceProject?: string,
    sourcePool?: string,
    volumeOnly?: boolean,
  ): Promise<void> {
    if (sourcePool && sourcePool !== pool) {
      console.warn(
        `[IncusStorageClient] WARNING: Cross-pool cloning detected from '${sourcePool}' to '${pool}'. ` +
          `This bypasses ZFS Copy-on-Write (CoW) and will trigger a heavy raw block copy (zfs send/recv) across physical drives.`,
      )
    }
    const rawPayload: IncusVolumeClonePayload = {
      name,
      type: 'custom',
      source: {
        name: volume,
        type: 'copy',
        project: sourceProject,
        pool: sourcePool || pool,
        volume_only: volumeOnly,
      },
      config,
    }
    const parsed = IncusVolumeClonePayloadSchema.safeParse(rawPayload)
    if (!parsed.success) {
      throw new IncusError('Invalid Incus Volume Clone Payload', 'VALIDATION_ERROR', z.treeifyError(parsed.error))
    }
    await this.transport.operation(`/storage-pools/${encodeURIComponent(pool)}/volumes/custom`, 'POST', {
      body: parsed.data,
    })
  }

  public async delete(pool: string, name: string): Promise<void> {
    await this.transport.operation(
      `/storage-pools/${encodeURIComponent(pool)}/volumes/custom/${encodeURIComponent(name)}`,
      'DELETE',
    )
  }
}
