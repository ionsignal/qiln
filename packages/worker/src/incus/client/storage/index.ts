import { z } from 'zod'
import { IncusError } from '../../../errors'
import {
  IncusVolumeCreatePayloadSchema,
  IncusVolumeClonePayloadSchema,
  IncusVolumeSnapshotClonePayloadSchema,
  type IncusVolumeCreatePayload,
  type IncusVolumeClonePayload,
  type IncusVolumeSnapshotClonePayload,
} from '../schemas/storage'
import { IncusStorageFilesClient } from './files'
import { snapshotIdentity, volumeIdentity } from './identity'
import { IncusStorageSnapshotsClient } from './snapshots'
import type { IIncusTransport } from '../types'

export interface IncusSnapshotCloneSource {
  project: string
  pool: string
  volume: string
  snapshot: string
}

/**
 * Interfaces with the Incus Storage API to handle ZFS volume orchestration.
 *
 * Snapshot Capture and fork must use exact persisted snapshot identities.
 * Neither read nor clone paths perform provider discovery.
 */
export class IncusStorageClient {
  public readonly files: IncusStorageFilesClient
  public readonly snapshots: IncusStorageSnapshotsClient

  constructor(private readonly transport: IIncusTransport) {
    this.files = new IncusStorageFilesClient(this.transport)
    this.snapshots = new IncusStorageSnapshotsClient(this.transport)
  }

  public async create(pool: string, name: string, config?: Record<string, string>): Promise<void> {
    const identity = volumeIdentity(pool, name)
    const rawPayload: IncusVolumeCreatePayload = {
      name: identity.volume,
      type: 'custom',
      content_type: 'filesystem',
      config,
    }
    const parsed = IncusVolumeCreatePayloadSchema.safeParse(rawPayload)
    if (!parsed.success) {
      throw new IncusError('Invalid Incus Volume Create Payload', 'VALIDATION_ERROR', z.treeifyError(parsed.error))
    }
    await this.transport.operation(`/storage-pools/${encodeURIComponent(identity.pool)}/volumes/custom`, 'POST', {
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
    const target = volumeIdentity(pool, name)
    const source = volumeIdentity(sourcePool ?? target.pool, volume)
    this.warnCrossPool(source.pool, target.pool)
    const rawPayload: IncusVolumeClonePayload = {
      name: target.volume,
      type: 'custom',
      source: {
        name: source.volume,
        type: 'copy',
        project: sourceProject,
        pool: source.pool,
        volume_only: volumeOnly,
      },
      config,
    }
    const parsed = IncusVolumeClonePayloadSchema.safeParse(rawPayload)
    if (!parsed.success) {
      throw new IncusError('Invalid Incus Volume Clone Payload', 'VALIDATION_ERROR', z.treeifyError(parsed.error))
    }
    await this.transport.operation(`/storage-pools/${encodeURIComponent(target.pool)}/volumes/custom`, 'POST', {
      body: parsed.data,
    })
  }

  /**
   * Clones one exact persisted custom-volume snapshot.
   *
   * Every source identity component is supplied separately and validated before
   * the snapshot-qualified Incus source name is constructed. This method
   * performs no listing, source lookup, ownership inference, or adoption.
   */
  public async cloneSnapshot(
    pool: string,
    name: string,
    source: IncusSnapshotCloneSource,
    config?: Record<string, string>,
  ): Promise<void> {
    const target = volumeIdentity(pool, name)
    const snapshot = snapshotIdentity(source.pool, source.volume, source.snapshot)
    if (source.project.trim() === '' || source.project.includes('/') || /[\u0000-\u001f\u007f]/.test(source.project)) {
      throw new IncusError('Incus snapshot source project is invalid.', 'VALIDATION_ERROR', {
        project: source.project,
      })
    }
    this.warnCrossPool(snapshot.pool, target.pool)
    const rawPayload: IncusVolumeSnapshotClonePayload = {
      name: target.volume,
      type: 'custom',
      source: {
        name: snapshot.qualifiedVolume,
        type: 'copy',
        project: source.project,
        pool: snapshot.pool,
        volume_only: true,
      },
      config,
    }
    const parsed = IncusVolumeSnapshotClonePayloadSchema.safeParse(rawPayload)
    if (!parsed.success) {
      throw new IncusError(
        'Invalid Incus Volume Snapshot Clone Payload',
        'VALIDATION_ERROR',
        z.treeifyError(parsed.error),
      )
    }
    await this.transport.operation(`/storage-pools/${encodeURIComponent(target.pool)}/volumes/custom`, 'POST', {
      body: parsed.data,
    })
  }

  public async delete(pool: string, name: string): Promise<void> {
    const identity = volumeIdentity(pool, name)
    await this.transport.operation(
      `/storage-pools/${encodeURIComponent(identity.pool)}/volumes/custom/${encodeURIComponent(identity.volume)}`,
      'DELETE',
    )
  }

  private warnCrossPool(sourcePool: string, targetPool: string): void {
    if (sourcePool === targetPool) {
      return
    }
    console.warn(
      `[IncusStorageClient] WARNING: Cross-pool cloning detected from '${sourcePool}' to '${targetPool}'. ` +
        `This bypasses ZFS Copy-on-Write (CoW) and will trigger a heavy raw block copy (zfs send/recv) across physical drives.`,
    )
  }
}
