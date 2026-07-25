import { z } from 'zod'

export const IncusVolumeConfigSchema = z.record(z.string(), z.string())

export const IncusVolumeSourceSchema = z
  .object({
    name: z.string(),
    type: z.literal('copy'),
    pool: z.string(),
    volume_only: z.boolean().optional(),
    project: z.string().optional(),
  })
  .strict()

export const IncusVolumeCreatePayloadSchema = z
  .object({
    name: z.string(),
    type: z.literal('custom'),
    content_type: z.literal('filesystem').optional(),
    config: IncusVolumeConfigSchema.optional(),
  })
  .strict()

export const IncusVolumeClonePayloadSchema = z
  .object({
    name: z.string(),
    type: z.literal('custom'),
    source: IncusVolumeSourceSchema,
    config: IncusVolumeConfigSchema.optional(),
  })
  .strict()

/**
 * Narrow payload used by experimental Snapshot Capture.
 *
 * Expiry is deliberately omitted. Retention and snapshot deletion will be
 * operation-specific policy rather than implicit provider expiration.
 */
export const IncusCustomVolumeSnapshotCreatePayloadSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
  })
  .strict()

/**
 * Directory response returned by the custom storage-volume Files API.
 *
 * Incus returns the listing inside its normal synchronous response envelope,
 * rather than as a bare string array. Individual names receive additional
 * canonical and traversal-safety validation in the storage Files client.
 */
export const IncusFileDirectoryResponseSchema = z.object({
  type: z.literal('sync'),
  status: z.string(),
  status_code: z.number(),
  metadata: z.array(z.string()),
})

export type IncusVolumeCreatePayload = z.infer<typeof IncusVolumeCreatePayloadSchema>
export type IncusVolumeClonePayload = z.infer<typeof IncusVolumeClonePayloadSchema>
export type IncusCustomVolumeSnapshotCreatePayload = z.infer<typeof IncusCustomVolumeSnapshotCreatePayloadSchema>
export type IncusFileDirectoryResponse = z.infer<typeof IncusFileDirectoryResponseSchema>
