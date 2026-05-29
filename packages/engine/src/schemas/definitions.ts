import { z } from 'zod'
import { IncusDeviceMapSchema } from './incus'

export const DataPlaneSchemaRegistry = {
  ServerPropertiesSchema: 'ServerPropertiesSchema',
} as const

export const VolumeDefinitionSchema = z
  .object({
    name: z.string(),
    type: z.enum(['clone', 'empty']),
    pool: z.string(),
    source_vault: z.string().optional(),
    shifted: z.boolean().optional(),
    mount_path: z.string(),
  })
  .strict()

export const FileDefinitionSchema = z
  .object({
    path: z.string(),
    uid: z.number().default(1000),
    gid: z.number().default(1000),
    mode: z.string().default('0644'),
    content: z.string(),
  })
  .strict()

export const AppDefinitionSchema = z
  .object({
    name: z.string(),
    display_name: z.string(),
    description: z.string(),
    image_alias: z.string(),
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
        ports: z
          .array(
            z
              .object({
                name: z.string(),
                port: z.number(),
                protocol: z.enum(['tcp', 'udp']),
              })
              .strict(),
          )
          .default([]),
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
