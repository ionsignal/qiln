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
    }
    const managedVolumes = volumes.filter(({ volume }) => volume.type !== 'bind')
    const bindMounts = volumes.filter(({ volume }) => volume.type === 'bind')

    /**
     * Managed volumes are independent restoration boundaries. Nested managed
     * mounts would obscure which restored volume owns the visible branch
     * state.
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
     * A nested bind target must exist in the underlying managed volume before
     * the bind is attached. Provisioning descendants would be obscured by the
     * bind or accidentally target its unversioned external contents.
     */
    for (const { volume: bind, index } of bindMounts) {
      const nested = managedVolumes.some(
        ({ volume }) => classifyAbsolutePosixPathRelationship(bind.mount_path, volume.mount_path) === 'descendant',
      )
      if (!nested) {
        continue
      }
      const provisioningPaths = blueprint.provisioning.files
        .map((file, fileIndex) => ({
          file,
          index: fileIndex,
          relationship: classifyAbsolutePosixPathRelationship(file.path, bind.mount_path),
        }))
        .filter(candidate => candidate.relationship === 'equal' || candidate.relationship === 'descendant')
      const directories = provisioningPaths.filter(candidate => candidate.relationship === 'equal')
      if (directories.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['provisioning', 'volumes', index, 'mount_path'],
          message: `Bind mount '${bind.name}' requires one empty directory provisioning entry at '${bind.mount_path}'.`,
        })
      }
      if (directories.length > 1) {
        for (const candidate of directories) {
          context.addIssue({
            code: 'custom',
            path: ['provisioning', 'files', candidate.index, 'path'],
            message: `Bind mount '${bind.name}' has duplicate bootstrap directory declarations at '${bind.mount_path}'.`,
          })
        }
      }
      for (const candidate of provisioningPaths) {
        if (candidate.relationship === 'descendant') {
          context.addIssue({
            code: 'custom',
            path: ['provisioning', 'files', candidate.index, 'path'],
            message: `Provisioning path '${candidate.file.path}' is beneath bind mount '${bind.name}'. Only the exact mount-target bootstrap directory is permitted.`,
          })
          continue
        }
        if (candidate.file.type !== 'directory') {
          context.addIssue({
            code: 'custom',
            path: ['provisioning', 'files', candidate.index, 'type'],
            message: `Bind mount '${bind.name}' bootstrap path '${bind.mount_path}' must be a directory.`,
          })
        }
        if (candidate.file.content !== undefined) {
          context.addIssue({
            code: 'custom',
            path: ['provisioning', 'files', candidate.index, 'content'],
            message: `Bind mount '${bind.name}' bootstrap directory cannot contain provisioning content.`,
          })
        }
      }
    }
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
