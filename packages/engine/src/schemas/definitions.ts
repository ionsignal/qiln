import { z } from 'zod'
import { IncusDeviceMapSchema } from './incus'

export const DataPlaneSchemaRegistry = {
  ServerPropertiesSchema: 'ServerPropertiesSchema',
  WorkflowEnvSchema: 'WorkflowEnvSchema',
} as const

export const VolumeTypeSchema = z.enum(['clone', 'empty', 'bind'])

export const BaseVolumeSchema = z.object({
  name: z.string(),
  mount_path: z.string(),
  readonly: z.boolean().default(false),
  shifted: z.boolean().default(true),
})

export const CloneVolumeSchema = BaseVolumeSchema.extend({
  type: z.literal('clone'),
  pool: z.string(),
  source_volume: z.string(),
}).strict()

export const EmptyVolumeSchema = BaseVolumeSchema.extend({
  type: z.literal('empty'),
  pool: z.string(),
}).strict()

export const BindMountVolumeSchema = BaseVolumeSchema.extend({
  type: z.literal('bind'),
  host_path: z.string(),
}).strict()

export const VolumeDefinitionSchema = z.discriminatedUnion('type', [CloneVolumeSchema, EmptyVolumeSchema, BindMountVolumeSchema])

export const FileDefinitionSchema = z
  .object({
    path: z.string(),
    type: z.enum(['file', 'directory', 'symlink']).default('file'),
    uid: z.number().default(1000),
    gid: z.number().default(1000),
    mode: z.string().default('0644'),
    content: z.string().optional(),
  })
  .strict()

export const PortDefinitionSchema = z
  .object({
    name: z.string(),
    port: z.number().int().min(1).max(65535),
    protocol: z.enum(['tcp', 'udp']),
    exposure: z.enum(['internal', 'proxy']),
  })
  .strict()

// export const GpuDefinitionSchema = z
//   .object({
//     required: z.boolean().default(false),
//     mig: z.boolean().default(false),
//     vram_reservation: z.string().optional(),
//   })
//   .strict()

export const AppDefinitionSchema = z
  .object({
    name: z.string(),
    display_name: z.string(),
    description: z.string(),
    image_alias: z.string(),
    // gpu: GpuDefinitionSchema.default({ required: false }),
    provisioning: z
      .object({
        volumes: z.array(VolumeDefinitionSchema).default([]),
        files: z.array(FileDefinitionSchema).default([]),
      })
      .strict()
      .default({ volumes: [], files: [] }),
    instance_template: z
      .object({
        config: z.record(z.string(), z.string()).default({}),
        devices: IncusDeviceMapSchema.default({}),
      })
      .strict(),
    application: z
      .object({
        ports: z.array(PortDefinitionSchema).default([]),
        editable_files: z
          .array(
            z
              .object({
                path: z.string(),
                format: z.enum(['properties', 'json', 'yaml']),
                schema: z.enum(DataPlaneSchemaRegistry),
              })
              .strict(),
          )
          .default([]),
      })
      .strict()
      .optional(),
  })
  .strict()

export type AppDefinition = z.infer<typeof AppDefinitionSchema>
export type VolumeDefinition = z.infer<typeof VolumeDefinitionSchema>
export type FileDefinition = z.infer<typeof FileDefinitionSchema>
