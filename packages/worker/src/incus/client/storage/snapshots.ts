import { z } from 'zod'
import { IncusError } from '../../../errors'
import {
  IncusCustomVolumeSnapshotCreatePayloadSchema,
  IncusCustomVolumeSnapshotSchema,
  type IncusCustomVolumeSnapshotCreatePayload,
  type IncusCustomVolumeSnapshot,
} from '../schemas/storage'
import { snapshotIdentity } from './identity'
import type { IIncusTransport } from '../types'

/**
 * Narrow custom-volume snapshot client used by Snapshot Capture.
 *
 * Every operation requires a complete caller-supplied provider identity. This
 * client deliberately exposes no listing, discovery, adoption, or inferred
 * ownership behavior.
 *
 * A retained snapshot is later read through the Files API as the qualified
 * volume identity `<source-volume>/<snapshot-name>`.
 */
export class IncusStorageSnapshotsClient {
  constructor(private readonly transport: IIncusTransport) {}

  /**
   * Reads one exact snapshot endpoint without listing or discovery.
   *
   * Callers may classify absence only from a validated Incus resource-not-found
   * response, never from a missing asynchronous-operation record.
   */
  public async get(pool: string, volume: string, snapshot: string): Promise<IncusCustomVolumeSnapshot> {
    const identity = snapshotIdentity(pool, volume, snapshot)
    const { data } = await this.transport.read(
      `/storage-pools/${encodeURIComponent(identity.pool)}/volumes/custom/${encodeURIComponent(identity.sourceVolume)}/snapshots/${encodeURIComponent(identity.snapshotName)}`,
      'GET',
    )
    const parsed = IncusCustomVolumeSnapshotSchema.safeParse(data)
    if (!parsed.success || parsed.data.name !== identity.snapshotName) {
      throw new IncusError('Incus returned invalid custom-volume snapshot identity metadata.', 'VALIDATION_ERROR', {
        pool: identity.pool,
        volume: identity.sourceVolume,
        snapshot: identity.snapshotName,
      })
    }
    return parsed.data
  }

  public async create(pool: string, volume: string, snapshot: string): Promise<void> {
    const identity = snapshotIdentity(pool, volume, snapshot)
    const rawPayload: IncusCustomVolumeSnapshotCreatePayload = {
      name: identity.snapshotName,
    }
    const parsed = IncusCustomVolumeSnapshotCreatePayloadSchema.safeParse(rawPayload)
    if (!parsed.success) {
      throw new IncusError(
        'Invalid Incus custom volume snapshot create payload.',
        'VALIDATION_ERROR',
        z.treeifyError(parsed.error),
      )
    }
    await this.transport.operation(
      `/storage-pools/${encodeURIComponent(identity.pool)}/volumes/custom/${encodeURIComponent(identity.sourceVolume)}/snapshots`,
      'POST',
      {
        body: parsed.data,
      },
    )
  }

  public async delete(pool: string, volume: string, snapshot: string): Promise<void> {
    const identity = snapshotIdentity(pool, volume, snapshot)
    await this.transport.operation(
      `/storage-pools/${encodeURIComponent(identity.pool)}/volumes/custom/${encodeURIComponent(identity.sourceVolume)}/snapshots/${encodeURIComponent(identity.snapshotName)}`,
      'DELETE',
    )
  }
}
