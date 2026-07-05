import { z } from 'zod'

/**
 * Runtime capsule blueprint schemas.
 *
 * This intentionally models only the Qiln capsule blueprint files under `catalog/blueprints`.
 * Image build YAMLs under `catalog/images` are external build inputs and are not part of
 * the runtime capsule contract.
 */

export const CapsuleBlueprintConfigMapSchema = z.record(z.string(), z.string())

/**
 * A narrow runtime-template device passthrough.
 *
 * We validate only the shape Qiln blueprints currently need: a named device with a string
 * `type` and string-valued attributes. This avoids turning @qiln/core into a full Incus API
 * schema package while preserving compatibility with current blueprint `instance_template.devices`.
 */
export const CapsuleBlueprintDeviceSchema = z
  .object({
    type: z.string(),
  })
  .catchall(z.string())

export const CapsuleBlueprintDeviceMapSchema = z.record(z.string(), CapsuleBlueprintDeviceSchema)

export const CapsuleBlueprintVolumeTypeSchema = z.enum(['clone', 'empty', 'bind'])

export const CapsuleBlueprintBaseVolumeSchema = z.object({
  name: z.string(),
  mount_path: z.string(),
  readonly: z.boolean().default(false),
  shifted: z.boolean().default(true),
})

export const CapsuleBlueprintCloneVolumeSchema = CapsuleBlueprintBaseVolumeSchema.extend({
  type: z.literal('clone'),
  pool: z.string(),
  source_volume: z.string(),
}).strict()

export const CapsuleBlueprintEmptyVolumeSchema = CapsuleBlueprintBaseVolumeSchema.extend({
  type: z.literal('empty'),
  pool: z.string(),
}).strict()

export const CapsuleBlueprintBindMountVolumeSchema = CapsuleBlueprintBaseVolumeSchema.extend({
  type: z.literal('bind'),
  host_path: z.string(),
}).strict()

export const CapsuleBlueprintVolumeDefinitionSchema = z.discriminatedUnion('type', [
  CapsuleBlueprintCloneVolumeSchema,
  CapsuleBlueprintEmptyVolumeSchema,
  CapsuleBlueprintBindMountVolumeSchema,
])

export const CapsuleBlueprintFileDefinitionSchema = z
  .object({
    path: z.string(),
    type: z.enum(['file', 'directory', 'symlink']).default('file'),
    uid: z.number().default(1000),
    gid: z.number().default(1000),
    mode: z.string().default('0644'),
    content: z.string().optional(),
  })
  .strict()

export const CapsuleBlueprintPortDefinitionSchema = z
  .object({
    name: z.string(),
    port: z.number().int().min(1).max(65535),
    protocol: z.enum(['tcp', 'udp']),
    exposure: z.enum(['internal', 'proxy']),
  })
  .strict()

export const CapsuleBlueprintSchema = z
  .object({
    name: z.string(),
    display_name: z.string(),
    description: z.string(),
    image_alias: z.string(),
    provisioning: z
      .object({
        volumes: z.array(CapsuleBlueprintVolumeDefinitionSchema).default([]),
        files: z.array(CapsuleBlueprintFileDefinitionSchema).default([]),
      })
      .strict()
      .default({ volumes: [], files: [] }),
    instance_template: z
      .object({
        config: CapsuleBlueprintConfigMapSchema.default({}),
        devices: CapsuleBlueprintDeviceMapSchema.default({}),
      })
      .strict(),
    application: z
      .object({
        ports: z.array(CapsuleBlueprintPortDefinitionSchema).default([]),
      })
      .strict()
      .optional(),
  })
  .strict()

/**
 * Client-safe blueprint manifest schemas.
 *
 * The manifest intentionally exposes provisionable capsule blueprint summaries,
 * not full runtime provisioning details. The worker remains authoritative for
 * full blueprint contents and returns stable digests for later verification.
 */
export const CapsuleBlueprintDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/, {
  message: "Capsule blueprint digests must use the format 'sha256:<64 lowercase hex characters>'.",
})

export const CapsuleBlueprintManifestItemSchema = z
  .object({
    name: z.string(),
    displayName: z.string(),
    description: z.string(),
    digest: CapsuleBlueprintDigestSchema,
  })
  .strict()

export const CapsuleBlueprintManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    catalogDigest: CapsuleBlueprintDigestSchema,
    blueprints: z.array(CapsuleBlueprintManifestItemSchema),
  })
  .strict()

export type CapsuleBlueprintConfigMap = z.infer<typeof CapsuleBlueprintConfigMapSchema>
export type CapsuleBlueprintDevice = z.infer<typeof CapsuleBlueprintDeviceSchema>
export type CapsuleBlueprintDeviceMap = z.infer<typeof CapsuleBlueprintDeviceMapSchema>
export type CapsuleBlueprintVolumeType = z.infer<typeof CapsuleBlueprintVolumeTypeSchema>
export type CapsuleBlueprintCloneVolume = z.infer<typeof CapsuleBlueprintCloneVolumeSchema>
export type CapsuleBlueprintEmptyVolume = z.infer<typeof CapsuleBlueprintEmptyVolumeSchema>
export type CapsuleBlueprintBindMountVolume = z.infer<typeof CapsuleBlueprintBindMountVolumeSchema>
export type CapsuleBlueprintVolumeDefinition = z.infer<typeof CapsuleBlueprintVolumeDefinitionSchema>
export type CapsuleBlueprintFileDefinition = z.infer<typeof CapsuleBlueprintFileDefinitionSchema>
export type CapsuleBlueprintPortDefinition = z.infer<typeof CapsuleBlueprintPortDefinitionSchema>
export type CapsuleBlueprint = z.infer<typeof CapsuleBlueprintSchema>
export type CapsuleBlueprintDigest = z.infer<typeof CapsuleBlueprintDigestSchema>
export type CapsuleBlueprintManifestItem = z.infer<typeof CapsuleBlueprintManifestItemSchema>
export type CapsuleBlueprintManifest = z.infer<typeof CapsuleBlueprintManifestSchema>
