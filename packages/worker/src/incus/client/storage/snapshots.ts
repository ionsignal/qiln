import { z } from 'zod'
import { IncusError } from '../../../errors'
import {
  IncusCustomVolumeSnapshotCreatePayloadSchema,
  type IncusCustomVolumeSnapshotCreatePayload,
} from '../schemas/storage'
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
    const rawPayload: IncusCustomVolumeSnapshotCreatePayload = {
      name: snapshot,
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
      `/storage-pools/${encodeURIComponent(pool)}/volumes/custom/${encodeURIComponent(volume)}/snapshots`,
      'POST',
      {
        body: parsed.data,
      },
    )
  }

  public async delete(pool: string, volume: string, snapshot: string): Promise<void> {
    await this.transport.operation(
      `/storage-pools/${encodeURIComponent(pool)}/volumes/custom/${encodeURIComponent(volume)}/snapshots/${encodeURIComponent(snapshot)}`,
      'DELETE',
    )
  }
}
