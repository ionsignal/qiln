import { CapsulePreviewEventName, TargetType, type CapsuleChannel } from '@qiln/core/server'
import type { PreviewRecord } from '../routing/preview'

export class CapsulePreviewEventPublisher {
  constructor(private readonly channel: CapsuleChannel) {}

  public changed(preview: PreviewRecord): void {
    void this.channel
      .publish(CapsulePreviewEventName.PREVIEW_CHANGED, {
        type: CapsulePreviewEventName.PREVIEW_CHANGED,
        target: {
          type: TargetType.OWNER,
          id: preview.ownerId,
        },
        previewId: preview.id,
        capsuleId: preview.capsuleId,
        branchId: preview.branchId,
        applicationName: preview.applicationName,
        status: preview.status,
      })
      .catch((error: unknown) => {
        console.warn(
          `[CapsulePreviewEventPublisher] Failed to publish preview '${preview.id}' status '${preview.status}'.`,
          error,
        )
      })
  }
}
