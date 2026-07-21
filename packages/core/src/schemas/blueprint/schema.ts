import { z } from 'zod'
import { classifyAbsolutePosixPathRelationship, joinAbsoluteAndRelativePosixPath } from '../posix'
import { CapsuleBlueprintSnapshotCapturePolicySchema, type CapsuleBlueprintArtifactRoot } from './capture'
import { DEFAULT_CAPSULE_BLUEPRINT_NAME, CapsuleBlueprintDigestSchema } from './catalog'
import {
  CapsuleBlueprintFileDefinitionSchema,
  CapsuleBlueprintIdentifierSchema,
  CapsuleBlueprintPortDefinitionSchema,
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
    snapshot_capture: CapsuleBlueprintSnapshotCapturePolicySchema,
    application: z
      .object({
        ports: z.array(CapsuleBlueprintPortDefinitionSchema).default([]),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((blueprint, context) => {
    const volumesByName = new Map<string, (typeof blueprint.provisioning.volumes)[number]>()
    const volumeIndexesByName = new Map<string, number>()
    const mountPathIndexes = new Map<string, number>()
    blueprint.provisioning.volumes.forEach((volume, index) => {
      const existingVolumeIndex = volumeIndexesByName.get(volume.name)
      if (existingVolumeIndex !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['provisioning', 'volumes', index, 'name'],
          message: `Duplicate provisioning volume name '${volume.name}' already appears at index ${existingVolumeIndex}.`,
        })
      } else {
        volumeIndexesByName.set(volume.name, index)
        volumesByName.set(volume.name, volume)
      }
      const existingMountPathIndex = mountPathIndexes.get(volume.mount_path)
      if (existingMountPathIndex !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['provisioning', 'volumes', index, 'mount_path'],
          message: `Duplicate provisioning mount path '${volume.mount_path}' already appears at index ${existingMountPathIndex}.`,
        })
      } else {
        mountPathIndexes.set(volume.mount_path, index)
      }
    })

    const artifactRootsById = new Map<string, CapsuleBlueprintArtifactRoot>()
    const artifactRootIndexesById = new Map<string, number>()
    const artifactRootVolumes = new Set<string>()
    const resolvedArtifactRoots: Array<{
      index: number
      id: string
      volume: string
      mountPath: string
    }> = []

    blueprint.snapshot_capture.artifact_roots.forEach((root, index) => {
      const existingRootIndex = artifactRootIndexesById.get(root.id)
      if (existingRootIndex !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['snapshot_capture', 'artifact_roots', index, 'id'],
          message: `Duplicate artifact root ID '${root.id}' already appears at index ${existingRootIndex}.`,
        })
      } else {
        artifactRootIndexesById.set(root.id, index)
        artifactRootsById.set(root.id, root)
      }
      if (artifactRootVolumes.has(root.volume)) {
        context.addIssue({
          code: 'custom',
          path: ['snapshot_capture', 'artifact_roots', index, 'volume'],
          message: `Provisioning volume '${root.volume}' is already used by another artifact root.`,
        })
      } else {
        artifactRootVolumes.add(root.volume)
      }
      const volume = volumesByName.get(root.volume)
      if (!volume) {
        context.addIssue({
          code: 'custom',
          path: ['snapshot_capture', 'artifact_roots', index, 'volume'],
          message: `Artifact root '${root.id}' references unknown provisioning volume '${root.volume}'.`,
        })
        return
      }
      if (volume.type === 'bind') {
        context.addIssue({
          code: 'custom',
          path: ['snapshot_capture', 'artifact_roots', index, 'volume'],
          message: `Artifact root '${root.id}' must reference a Qiln-managed clone or empty volume, not a bind mount.`,
        })
        return
      }
      resolvedArtifactRoots.push({
        index,
        id: root.id,
        volume: root.volume,
        mountPath: volume.mount_path,
      })
      const requiredPathIndexes = new Map<string, number>()
      root.required_paths.forEach((requiredPath, requiredPathIndex) => {
        const existingRequiredPathIndex = requiredPathIndexes.get(requiredPath.path)
        if (existingRequiredPathIndex !== undefined) {
          context.addIssue({
            code: 'custom',
            path: ['snapshot_capture', 'artifact_roots', index, 'required_paths', requiredPathIndex, 'path'],
            message: `Required artifact path '${requiredPath.path}' already appears at index ${existingRequiredPathIndex}.`,
          })
        } else {
          requiredPathIndexes.set(requiredPath.path, requiredPathIndex)
        }
      })
    })

    for (let leftIndex = 0; leftIndex < resolvedArtifactRoots.length; leftIndex++) {
      const left = resolvedArtifactRoots[leftIndex]!
      for (let rightIndex = leftIndex + 1; rightIndex < resolvedArtifactRoots.length; rightIndex++) {
        const right = resolvedArtifactRoots[rightIndex]!
        if (classifyAbsolutePosixPathRelationship(left.mountPath, right.mountPath) !== 'disjoint') {
          context.addIssue({
            code: 'custom',
            path: ['snapshot_capture', 'artifact_roots', right.index, 'volume'],
            message: `Artifact roots '${left.id}' and '${right.id}' have overlapping managed mount paths.`,
          })
        }
      }
    }

    /**
     * Artifact roots capture one managed storage boundary. V1 does not model a
     * separate clone or empty volume mounted inside or around that boundary;
     * only explicitly declared bind mounts may form nested capture boundaries.
     */
    blueprint.provisioning.volumes.forEach((volume, volumeIndex) => {
      if (volume.type === 'bind') {
        return
      }
      for (const artifactRoot of resolvedArtifactRoots) {
        if (volume.name === artifactRoot.volume) {
          continue
        }
        if (classifyAbsolutePosixPathRelationship(volume.mount_path, artifactRoot.mountPath) === 'disjoint') {
          continue
        }
        context.addIssue({
          code: 'custom',
          path: ['provisioning', 'volumes', volumeIndex, 'mount_path'],
          message: `Managed volume '${volume.name}' overlaps artifact root '${artifactRoot.id}'. V1 snapshot capture requires managed volumes other than the root volume to be disjoint from artifact roots.`,
        })
      }
    })

    /**
     * A bind mount may be disjoint from managed roots or form an explicitly
     * declared strict-descendant capture boundary. A bind mount equal to or
     * containing a managed root would shadow that root and is always invalid.
     */
    blueprint.provisioning.volumes.forEach((volume, volumeIndex) => {
      if (volume.type !== 'bind') {
        return
      }
      for (const artifactRoot of resolvedArtifactRoots) {
        const relationship = classifyAbsolutePosixPathRelationship(volume.mount_path, artifactRoot.mountPath)
        if (relationship === 'equal') {
          context.addIssue({
            code: 'custom',
            path: ['provisioning', 'volumes', volumeIndex, 'mount_path'],
            message: `Bind mount '${volume.name}' equals artifact root '${artifactRoot.id}' and would shadow the managed artifact root.`,
          })
        } else if (relationship === 'ancestor') {
          context.addIssue({
            code: 'custom',
            path: ['provisioning', 'volumes', volumeIndex, 'mount_path'],
            message: `Bind mount '${volume.name}' contains artifact root '${artifactRoot.id}' and would shadow the managed artifact root.`,
          })
        }
      }
    })

    const externalMountIndexesByVolume = new Map<string, number>()
    const resolvedExternalMounts: Array<{
      index: number
      volume: string
      mountPath: string
      artifactRootId: string
    }> = []

    blueprint.snapshot_capture.external_mounts.forEach((externalMount, index) => {
      const existingExternalMountIndex = externalMountIndexesByVolume.get(externalMount.volume)
      if (existingExternalMountIndex !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['snapshot_capture', 'external_mounts', index, 'volume'],
          message: `External mount '${externalMount.volume}' already appears at index ${existingExternalMountIndex}.`,
        })
      } else {
        externalMountIndexesByVolume.set(externalMount.volume, index)
      }
      const volume = volumesByName.get(externalMount.volume)
      if (!volume) {
        context.addIssue({
          code: 'custom',
          path: ['snapshot_capture', 'external_mounts', index, 'volume'],
          message: `External mount references unknown provisioning volume '${externalMount.volume}'.`,
        })
        return
      }
      if (volume.type !== 'bind') {
        context.addIssue({
          code: 'custom',
          path: ['snapshot_capture', 'external_mounts', index, 'volume'],
          message: `External mount '${externalMount.volume}' must reference a bind volume.`,
        })
        return
      }
      const shadowedRoots = resolvedArtifactRoots.filter(root => {
        const relationship = classifyAbsolutePosixPathRelationship(volume.mount_path, root.mountPath)
        return relationship === 'equal' || relationship === 'ancestor'
      })
      if (shadowedRoots.length > 0) {
        return
      }
      const containingRoots = resolvedArtifactRoots.filter(
        root => classifyAbsolutePosixPathRelationship(volume.mount_path, root.mountPath) === 'descendant',
      )
      if (containingRoots.length !== 1) {
        context.addIssue({
          code: 'custom',
          path: ['snapshot_capture', 'external_mounts', index, 'volume'],
          message: `External mount '${externalMount.volume}' must be a strict descendant of exactly one managed artifact root.`,
        })
        return
      }
      resolvedExternalMounts.push({
        index,
        volume: externalMount.volume,
        mountPath: volume.mount_path,
        artifactRootId: containingRoots[0]!.id,
      })
    })

    for (let leftIndex = 0; leftIndex < resolvedExternalMounts.length; leftIndex++) {
      const left = resolvedExternalMounts[leftIndex]!
      for (let rightIndex = leftIndex + 1; rightIndex < resolvedExternalMounts.length; rightIndex++) {
        const right = resolvedExternalMounts[rightIndex]!
        if (classifyAbsolutePosixPathRelationship(left.mountPath, right.mountPath) !== 'disjoint') {
          context.addIssue({
            code: 'custom',
            path: ['snapshot_capture', 'external_mounts', right.index, 'volume'],
            message: `External mount boundaries '${left.volume}' and '${right.volume}' overlap. External capture boundaries must be disjoint.`,
          })
        }
      }
    }

    blueprint.provisioning.volumes.forEach((volume, index) => {
      if (volume.type !== 'bind') {
        return
      }
      const nestedUnderArtifactRoot = resolvedArtifactRoots.some(
        root => classifyAbsolutePosixPathRelationship(volume.mount_path, root.mountPath) === 'descendant',
      )
      if (nestedUnderArtifactRoot && !externalMountIndexesByVolume.has(volume.name)) {
        context.addIssue({
          code: 'custom',
          path: ['provisioning', 'volumes', index, 'name'],
          message: `Bind mount '${volume.name}' is nested beneath an artifact root and must be declared in snapshot_capture.external_mounts.`,
        })
      }
    })

    blueprint.snapshot_capture.artifact_roots.forEach((root, rootIndex) => {
      const resolvedRoot = resolvedArtifactRoots.find(candidate => candidate.id === root.id)
      if (!resolvedRoot) {
        return
      }
      root.required_paths.forEach((requiredPath, requiredPathIndex) => {
        const absoluteRequiredPath = joinAbsoluteAndRelativePosixPath(resolvedRoot.mountPath, requiredPath.path)
        const boundary = resolvedExternalMounts.find(
          externalMount =>
            externalMount.artifactRootId === root.id &&
            classifyAbsolutePosixPathRelationship(absoluteRequiredPath, externalMount.mountPath) !== 'disjoint',
        )
        if (boundary) {
          context.addIssue({
            code: 'custom',
            path: ['snapshot_capture', 'artifact_roots', rootIndex, 'required_paths', requiredPathIndex, 'path'],
            message: `Required path '${requiredPath.path}' overlaps external mount '${boundary.volume}'.`,
          })
        }
      })
    })

    const gitRepositoryIndexesById = new Map<string, number>()
    const gitRepositoryIndexesByLocation = new Map<string, number>()
    blueprint.snapshot_capture.git_repositories.forEach((repository, index) => {
      const existingRepositoryIdIndex = gitRepositoryIndexesById.get(repository.id)
      if (existingRepositoryIdIndex !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['snapshot_capture', 'git_repositories', index, 'id'],
          message: `Git repository ID '${repository.id}' already appears at index ${existingRepositoryIdIndex}.`,
        })
      } else {
        gitRepositoryIndexesById.set(repository.id, index)
      }
      const root = artifactRootsById.get(repository.artifact_root_id)
      const resolvedRoot = resolvedArtifactRoots.find(candidate => candidate.id === repository.artifact_root_id)
      if (!root || !resolvedRoot) {
        context.addIssue({
          code: 'custom',
          path: ['snapshot_capture', 'git_repositories', index, 'artifact_root_id'],
          message: `Git repository '${repository.id}' references unknown or invalid artifact root '${repository.artifact_root_id}'.`,
        })
        return
      }
      const locationIdentity = `${repository.artifact_root_id}\u0000${repository.path}`
      const existingLocationIndex = gitRepositoryIndexesByLocation.get(locationIdentity)
      if (existingLocationIndex !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['snapshot_capture', 'git_repositories', index, 'path'],
          message: `Git repository location '${repository.artifact_root_id}:${repository.path}' already appears at index ${existingLocationIndex}.`,
        })
      } else {
        gitRepositoryIndexesByLocation.set(locationIdentity, index)
      }
      const absoluteRepositoryPath = joinAbsoluteAndRelativePosixPath(resolvedRoot.mountPath, repository.path)
      const conflictingExternalMount = resolvedExternalMounts.find(
        externalMount =>
          externalMount.artifactRootId === repository.artifact_root_id &&
          classifyAbsolutePosixPathRelationship(absoluteRepositoryPath, externalMount.mountPath) !== 'disjoint',
      )
      if (conflictingExternalMount) {
        context.addIssue({
          code: 'custom',
          path: ['snapshot_capture', 'git_repositories', index, 'path'],
          message: `Git repository '${repository.id}' overlaps external mount boundary '${conflictingExternalMount.volume}'. Git repositories and external mount boundaries must be disjoint.`,
        })
      }

      /**
       * Declared repositories are intentionally not rejected for strict
       * parent/child nesting. Duplicate locations are rejected above, while
       * collector-time validation will require every nested repository to be
       * explicitly declared and structurally supported.
       */
    })

    blueprint.provisioning.files.forEach((file, index) => {
      const externalMount = resolvedExternalMounts.find(candidate => {
        const relationship = classifyAbsolutePosixPathRelationship(file.path, candidate.mountPath)
        return relationship === 'equal' || relationship === 'descendant'
      })
      if (!externalMount) {
        return
      }
      context.addIssue({
        code: 'custom',
        path: ['provisioning', 'files', index, 'path'],
        message: `Provisioning path '${file.path}' falls beneath external mount '${externalMount.volume}'.`,
      })
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
