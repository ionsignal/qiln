import { z } from 'zod'
import { IncusError } from '../../../errors'
import {
  IncusCustomVolumeSnapshotCreatePayloadSchema,
  type IncusCustomVolumeSnapshotCreatePayload,
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
