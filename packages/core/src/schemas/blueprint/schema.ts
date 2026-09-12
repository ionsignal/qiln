import { z } from 'zod'
import { classifyAbsolutePosixPathRelationship } from '../posix'
import { CapsuleBlueprintApplicationSchema } from './application'
import { CapsuleBlueprintSnapshotSchema } from './snapshot'
import { DEFAULT_CAPSULE_BLUEPRINT_NAME, CapsuleBlueprintDigestSchema } from './catalog'
import {
  CapsuleBlueprintFileDefinitionSchema,
  CapsuleBlueprintIdentifierSchema,
  CapsuleBlueprintRuntimeSchema,
  CapsuleBlueprintVolumeDefinitionSchema,
} from './provision'

export const CAPSULE_BLUEPRINT_SCHEMA_VERSION = 1 as const

export const CapsuleBlueprintSchema = z
  .object({
    schema_version: z.literal(CAPSULE_BLUEPRINT_SCHEMA_VERSION),
    name: CapsuleBlueprintIdentifierSchema,
    display_name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    image_alias: z.string().trim().min(1),
    provisioning: z
      .object({
        volumes: z.array(CapsuleBlueprintVolumeDefinitionSchema).default([]),
        files: z.array(CapsuleBlueprintFileDefinitionSchema).default([]),
      })
      .strict()
      .default({ volumes: [], files: [] }),
    runtime: CapsuleBlueprintRuntimeSchema,
    snapshot: CapsuleBlueprintSnapshotSchema,
    applications: z.array(CapsuleBlueprintApplicationSchema).min(1),
  })
  .strict()
  .superRefine((blueprint, context) => {
    const volumeIndexes = new Map<string, number>()
    const mountIndexes = new Map<string, number>()
    const volumes = blueprint.provisioning.volumes.map((volume, index) => ({
      volume,
      index,
    }))
    for (const { volume, index } of volumes) {
      const existingVolumeIndex = volumeIndexes.get(volume.name)
      if (existingVolumeIndex !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['provisioning', 'volumes', index, 'name'],
          message: `Duplicate provisioning volume name '${volume.name}' already appears at index ${existingVolumeIndex}.`,
        })
      } else {
        volumeIndexes.set(volume.name, index)
      }
      const existingMountIndex = mountIndexes.get(volume.mount_path)
      if (existingMountIndex !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['provisioning', 'volumes', index, 'mount_path'],
          message: `Duplicate provisioning mount path '${volume.mount_path}' already appears at index ${existingMountIndex}.`,
        })
      } else {
        mountIndexes.set(volume.mount_path, index)
      }
      const workspaceRelationship = classifyAbsolutePosixPathRelationship(volume.mount_path, '/workspace')
      if (workspaceRelationship === 'equal' || workspaceRelationship === 'ancestor') {
        context.addIssue({
          code: 'custom',
          path: ['provisioning', 'volumes', index, 'mount_path'],
          message: "Volume mounts cannot equal or contain '/workspace'; it must remain an ordinary rootfs directory.",
        })
      }
    }
    const managedVolumes = volumes.filter(({ volume }) => volume.type !== 'bind')
    const bindMounts = volumes.filter(({ volume }) => volume.type === 'bind')

    /**
     * Managed volumes are independent storage boundaries. Nested managed mounts
     * would obscure which volume owns visible branch state and whether that
     * state participates in snapshot restoration.
     */
    for (let leftIndex = 0; leftIndex < managedVolumes.length; leftIndex++) {
      const left = managedVolumes[leftIndex]!
      for (let rightIndex = leftIndex + 1; rightIndex < managedVolumes.length; rightIndex++) {
        const right = managedVolumes[rightIndex]!
        if (classifyAbsolutePosixPathRelationship(left.volume.mount_path, right.volume.mount_path) === 'disjoint') {
          continue
        }
        context.addIssue({
          code: 'custom',
          path: ['provisioning', 'volumes', right.index, 'mount_path'],
          message: `Managed volumes '${left.volume.name}' and '${right.volume.name}' must have disjoint mount paths.`,
        })
      }
    }

    /**
     * Bind mounts may be disjoint from managed volumes or nested beneath them.
     * A bind mount equal to or containing a managed volume would shadow the
     * restored branch state.
     */
    for (const { volume: bind, index } of bindMounts) {
      for (const { volume: managed } of managedVolumes) {
        const relationship = classifyAbsolutePosixPathRelationship(bind.mount_path, managed.mount_path)
        if (relationship !== 'equal' && relationship !== 'ancestor') {
          continue
        }
        context.addIssue({
          code: 'custom',
          path: ['provisioning', 'volumes', index, 'mount_path'],
          message: `Bind mount '${bind.name}' cannot equal or contain managed volume '${managed.name}'.`,
        })
      }
    }

    /**
     * Provisioning initializes rootfs paths and versioned empty volumes only.
     * Checking every enclosing mount prevents a nested bind from inheriting the
     * writable provisioning policy of its enclosing managed volume. Ancestor
     * directories such as /workspace remain rootfs targets.
     */
    blueprint.provisioning.files.forEach((file, index) => {
      for (const { volume } of volumes) {
        const relationship = classifyAbsolutePosixPathRelationship(file.path, volume.mount_path)
        if (relationship !== 'equal' && relationship !== 'descendant') {
          continue
        }
        if (volume.type === 'empty' && volume.versioned) {
          continue
        }
        context.addIssue({
          code: 'custom',
          path: ['provisioning', 'files', index, 'path'],
          message: `Provisioning path '${file.path}' targets volume '${volume.name}'. Only rootfs paths and versioned empty volumes may receive provisioning files.`,
        })
      }
    })
    const applicationIndexes = new Map<string, number>()
    blueprint.applications.forEach((application, index) => {
      const existingIndex = applicationIndexes.get(application.name)
      if (existingIndex !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['applications', index, 'name'],
          message: `Blueprint application '${application.name}' already appears at index ${existingIndex}.`,
        })
      } else {
        applicationIndexes.set(application.name, index)
      }
    })
  })

/**
 * Server-side resolved blueprint pin.
 *
 * The registry produces this value after verifying a reviewed catalog digest.
 * Accepted operations persist the full blueprint so execution does not depend
 * on later mutable YAML catalog state.
 */
export const CapsuleBlueprintPinSchema = z
  .object({
    name: z.string(),
    digest: CapsuleBlueprintDigestSchema,
    blueprint: CapsuleBlueprintSchema,
  })
  .strict()

export type CapsuleBlueprint = z.infer<typeof CapsuleBlueprintSchema>
export type CapsuleBlueprintPin = z.infer<typeof CapsuleBlueprintPinSchema>

export { DEFAULT_CAPSULE_BLUEPRINT_NAME }
