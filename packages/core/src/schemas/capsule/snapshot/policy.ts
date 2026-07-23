import { z } from 'zod'
import {
  CAPSULE_SNAPSHOT_CAPTURE_POLICY_VERSION,
  CapsuleBlueprintArtifactExclusionSchema,
  CapsuleBlueprintArtifactRequiredPathSchema,
  CapsuleBlueprintRepositoryRelativePathSchema,
  CapsuleBlueprintSnapshotCaptureApplicationCapabilitySchema,
} from '../../blueprint/capture'
import { CapsuleBlueprintDigestSchema } from '../../blueprint/catalog'
import { CapsuleBlueprintIdentifierSchema } from '../../blueprint/provision'
import {
  classifyAbsolutePosixPathRelationship,
  isCanonicalRelativePosixPath,
  joinAbsoluteAndRelativePosixPath,
} from '../../posix'
import { CapsuleArtifactLogicalPathSchema, CapsuleArtifactRootIdSchema } from '../artifact/entry'
import { CapsuleSnapshotDependencyDeclarationSchema } from './dependency'

export const CAPSULE_SNAPSHOT_CAPTURE_POLICY_PIN_SCHEMA_VERSION = 1 as const

export const CapsuleSnapshotCapturePolicyPinSchemaVersionSchema = z.literal(
  CAPSULE_SNAPSHOT_CAPTURE_POLICY_PIN_SCHEMA_VERSION,
)

export const CapsuleSnapshotCapturePolicyDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/, {
  message: "Snapshot capture-policy digests must use the format 'sha256:<64 lowercase hex characters>'.",
})

export const CapsuleSnapshotCapturePolicyArtifactRootSchema = z
  .object({
    id: CapsuleArtifactRootIdSchema,
    blueprintVolumeName: CapsuleBlueprintIdentifierSchema,
    logicalPath: CapsuleArtifactLogicalPathSchema,
    required: z.boolean(),
    requiredPaths: z.array(CapsuleBlueprintArtifactRequiredPathSchema),
    exclusions: z.array(CapsuleBlueprintArtifactExclusionSchema),
  })
  .strict()

export const CapsuleSnapshotCapturePolicyExternalMountSchema = z
  .object({
    blueprintVolumeName: CapsuleBlueprintIdentifierSchema,
    artifactRootId: CapsuleArtifactRootIdSchema,
    logicalPath: CapsuleArtifactLogicalPathSchema,
    required: z.boolean(),
    dependency: CapsuleSnapshotDependencyDeclarationSchema,
  })
  .strict()

export const CapsuleSnapshotCapturePolicyGitRepositorySchema = z
  .object({
    id: CapsuleBlueprintIdentifierSchema,
    artifactRootId: CapsuleArtifactRootIdSchema,
    path: CapsuleBlueprintRepositoryRelativePathSchema,
    logicalPath: CapsuleArtifactLogicalPathSchema,
    required: z.boolean(),
  })
  .strict()

const CapsuleSnapshotCapturePolicyFieldsSchema = z
  .object({
    schemaVersion: CapsuleSnapshotCapturePolicyPinSchemaVersionSchema,
    blueprintName: CapsuleBlueprintIdentifierSchema,
    blueprintDigest: CapsuleBlueprintDigestSchema,
    policyVersion: z.literal(CAPSULE_SNAPSHOT_CAPTURE_POLICY_VERSION),
    artifactRoots: z.array(CapsuleSnapshotCapturePolicyArtifactRootSchema).min(1),
    externalMounts: z.array(CapsuleSnapshotCapturePolicyExternalMountSchema),
    gitRepositories: z.array(CapsuleSnapshotCapturePolicyGitRepositorySchema),
    applicationCapabilities: z.array(CapsuleBlueprintSnapshotCaptureApplicationCapabilitySchema).min(1),
  })
  .strict()

type CapsuleSnapshotCapturePolicyFields = z.infer<typeof CapsuleSnapshotCapturePolicyFieldsSchema>

interface PolicyIssue {
  code: 'custom'
  path: Array<string | number>
  message: string
}

function isEqualOrAncestorPath(left: string, right: string): boolean {
  const relationship = classifyAbsolutePosixPathRelationship(left, right)
  return relationship === 'equal' || relationship === 'ancestor'
}

function validateRootPaths(
  root: CapsuleSnapshotCapturePolicyFields['artifactRoots'][number],
  rootIndex: number,
  addIssue: (issue: PolicyIssue) => void,
): void {
  const requiredPathIndexes = new Map<string, number>()
  root.requiredPaths.forEach((requiredPath, requiredPathIndex) => {
    const existingIndex = requiredPathIndexes.get(requiredPath.path)
    if (existingIndex !== undefined) {
      addIssue({
        code: 'custom',
        path: ['artifactRoots', rootIndex, 'requiredPaths', requiredPathIndex, 'path'],
        message: `Required artifact path '${requiredPath.path}' is already declared at index ${existingIndex}.`,
      })
    } else {
      requiredPathIndexes.set(requiredPath.path, requiredPathIndex)
    }
  })

  const exclusionPathIndexes = new Map<string, number>()
  root.exclusions.forEach((exclusion, exclusionIndex) => {
    const existingIndex = exclusionPathIndexes.get(exclusion.path)
    if (existingIndex !== undefined) {
      addIssue({
        code: 'custom',
        path: ['artifactRoots', rootIndex, 'exclusions', exclusionIndex, 'path'],
        message: `Artifact exclusion path '${exclusion.path}' is already declared at index ${existingIndex}.`,
      })
    } else {
      exclusionPathIndexes.set(exclusion.path, exclusionIndex)
    }
  })

  for (let requiredIndex = 0; requiredIndex < root.requiredPaths.length; requiredIndex++) {
    const requiredPath = root.requiredPaths[requiredIndex]!
    if (requiredPath.type !== 'file') {
      continue
    }
    const absoluteRequiredPath = joinAbsoluteAndRelativePosixPath(root.logicalPath, requiredPath.path)
    for (let comparedIndex = 0; comparedIndex < root.requiredPaths.length; comparedIndex++) {
      if (requiredIndex === comparedIndex) {
        continue
      }
      const comparedPath = root.requiredPaths[comparedIndex]!
      const absoluteComparedPath = joinAbsoluteAndRelativePosixPath(root.logicalPath, comparedPath.path)
      if (classifyAbsolutePosixPathRelationship(absoluteRequiredPath, absoluteComparedPath) !== 'ancestor') {
        continue
      }
      addIssue({
        code: 'custom',
        path: ['artifactRoots', rootIndex, 'requiredPaths', comparedIndex, 'path'],
        message: `Required artifact path '${comparedPath.path}' cannot be nested beneath required file '${requiredPath.path}'.`,
      })
    }
  }

  for (let leftIndex = 0; leftIndex < root.exclusions.length; leftIndex++) {
    const left = root.exclusions[leftIndex]!
    const absoluteLeftPath = joinAbsoluteAndRelativePosixPath(root.logicalPath, left.path)
    for (let rightIndex = leftIndex + 1; rightIndex < root.exclusions.length; rightIndex++) {
      const right = root.exclusions[rightIndex]!
      const absoluteRightPath = joinAbsoluteAndRelativePosixPath(root.logicalPath, right.path)
      if (classifyAbsolutePosixPathRelationship(absoluteLeftPath, absoluteRightPath) === 'disjoint') {
        continue
      }
      addIssue({
        code: 'custom',
        path: ['artifactRoots', rootIndex, 'exclusions', rightIndex, 'path'],
        message: `Artifact exclusions '${left.path}' and '${right.path}' overlap. Exclusions must be disjoint.`,
      })
    }
  }

  root.requiredPaths.forEach(requiredPath => {
    const absoluteRequiredPath = joinAbsoluteAndRelativePosixPath(root.logicalPath, requiredPath.path)
    root.exclusions.forEach((exclusion, exclusionIndex) => {
      const absoluteExclusionPath = joinAbsoluteAndRelativePosixPath(root.logicalPath, exclusion.path)
      if (isEqualOrAncestorPath(absoluteExclusionPath, absoluteRequiredPath)) {
        addIssue({
          code: 'custom',
          path: ['artifactRoots', rootIndex, 'exclusions', exclusionIndex, 'path'],
          message: `Artifact exclusion '${exclusion.path}' cannot equal or contain required artifact path '${requiredPath.path}'.`,
        })
        return
      }
      if (requiredPath.type === 'file' && isEqualOrAncestorPath(absoluteRequiredPath, absoluteExclusionPath)) {
        addIssue({
          code: 'custom',
          path: ['artifactRoots', rootIndex, 'exclusions', exclusionIndex, 'path'],
          message: `Artifact exclusion '${exclusion.path}' cannot be nested beneath required file '${requiredPath.path}'.`,
        })
      }
    })
  })
}

function validateCapturePolicy(
  policy: CapsuleSnapshotCapturePolicyFields,
  addIssue: (issue: PolicyIssue) => void,
): void {
  const rootsById = new Map<string, (typeof policy.artifactRoots)[number]>()
  const rootIndexesById = new Map<string, number>()
  const rootVolumeIndexes = new Map<string, number>()
  const rootPathIndexes = new Map<string, number>()
  policy.artifactRoots.forEach((root, index) => {
    const rootIndex = rootIndexesById.get(root.id)
    if (rootIndex !== undefined) {
      addIssue({
        code: 'custom',
        path: ['artifactRoots', index, 'id'],
        message: `Duplicate snapshot capture-policy artifact root ID '${root.id}' already appears at index ${rootIndex}.`,
      })
    } else {
      rootIndexesById.set(root.id, index)
      rootsById.set(root.id, root)
    }
    const volumeIndex = rootVolumeIndexes.get(root.blueprintVolumeName)
    if (volumeIndex !== undefined) {
      addIssue({
        code: 'custom',
        path: ['artifactRoots', index, 'blueprintVolumeName'],
        message: `Snapshot capture-policy blueprint volume '${root.blueprintVolumeName}' is already used by root at index ${volumeIndex}.`,
      })
    } else {
      rootVolumeIndexes.set(root.blueprintVolumeName, index)
    }
    const pathIndex = rootPathIndexes.get(root.logicalPath)
    if (pathIndex !== undefined) {
      addIssue({
        code: 'custom',
        path: ['artifactRoots', index, 'logicalPath'],
        message: `Snapshot capture-policy logical root path '${root.logicalPath}' is already used at index ${pathIndex}.`,
      })
    } else {
      rootPathIndexes.set(root.logicalPath, index)
    }
    validateRootPaths(root, index, addIssue)
  })
  for (let leftIndex = 0; leftIndex < policy.artifactRoots.length; leftIndex++) {
    const left = policy.artifactRoots[leftIndex]!
    for (let rightIndex = leftIndex + 1; rightIndex < policy.artifactRoots.length; rightIndex++) {
      const right = policy.artifactRoots[rightIndex]!
      if (classifyAbsolutePosixPathRelationship(left.logicalPath, right.logicalPath) === 'disjoint') {
        continue
      }
      addIssue({
        code: 'custom',
        path: ['artifactRoots', rightIndex, 'logicalPath'],
        message: `Snapshot capture-policy artifact roots '${left.id}' and '${right.id}' overlap.`,
      })
    }
  }
  const externalVolumeIndexes = new Map<string, number>()
  const dependencyIndexes = new Map<string, number>()
  policy.externalMounts.forEach((mount, index) => {
    const rootVolumeIndex = rootVolumeIndexes.get(mount.blueprintVolumeName)
    if (rootVolumeIndex !== undefined) {
      addIssue({
        code: 'custom',
        path: ['externalMounts', index, 'blueprintVolumeName'],
        message: `Snapshot capture-policy external volume '${mount.blueprintVolumeName}' is already used by artifact root at index ${rootVolumeIndex}.`,
      })
    }
    const volumeIndex = externalVolumeIndexes.get(mount.blueprintVolumeName)
    if (volumeIndex !== undefined) {
      addIssue({
        code: 'custom',
        path: ['externalMounts', index, 'blueprintVolumeName'],
        message: `Snapshot capture-policy external volume '${mount.blueprintVolumeName}' is already declared at index ${volumeIndex}.`,
      })
    } else {
      externalVolumeIndexes.set(mount.blueprintVolumeName, index)
    }
    const dependencyIdentity = `${mount.dependency.kind}\u0000${mount.dependency.logicalId}`
    const dependencyIndex = dependencyIndexes.get(dependencyIdentity)
    if (dependencyIndex !== undefined) {
      addIssue({
        code: 'custom',
        path: ['externalMounts', index, 'dependency', 'logicalId'],
        message: `Snapshot capture-policy dependency '${mount.dependency.kind}:${mount.dependency.logicalId}' is already assigned to external mount at index ${dependencyIndex}.`,
      })
    } else {
      dependencyIndexes.set(dependencyIdentity, index)
    }
    const root = rootsById.get(mount.artifactRootId)
    if (!root) {
      addIssue({
        code: 'custom',
        path: ['externalMounts', index, 'artifactRootId'],
        message: `Snapshot capture-policy external mount references unknown artifact root '${mount.artifactRootId}'.`,
      })
      return
    }
    if (classifyAbsolutePosixPathRelationship(mount.logicalPath, root.logicalPath) !== 'descendant') {
      addIssue({
        code: 'custom',
        path: ['externalMounts', index, 'logicalPath'],
        message: `Snapshot capture-policy external mount '${mount.blueprintVolumeName}' must be a strict descendant of artifact root '${root.id}'.`,
      })
    }
    root.requiredPaths.forEach(requiredPath => {
      const absoluteRequiredPath = joinAbsoluteAndRelativePosixPath(root.logicalPath, requiredPath.path)
      if (classifyAbsolutePosixPathRelationship(absoluteRequiredPath, mount.logicalPath) === 'disjoint') {
        return
      }
      addIssue({
        code: 'custom',
        path: ['externalMounts', index, 'logicalPath'],
        message: `Snapshot capture-policy external mount '${mount.blueprintVolumeName}' overlaps required path '${requiredPath.path}' in artifact root '${root.id}'.`,
      })
    })
    root.exclusions.forEach(exclusion => {
      const absoluteExclusionPath = joinAbsoluteAndRelativePosixPath(root.logicalPath, exclusion.path)
      if (classifyAbsolutePosixPathRelationship(absoluteExclusionPath, mount.logicalPath) === 'disjoint') {
        return
      }
      addIssue({
        code: 'custom',
        path: ['externalMounts', index, 'logicalPath'],
        message: `Snapshot capture-policy external mount '${mount.blueprintVolumeName}' overlaps exclusion '${exclusion.path}' in artifact root '${root.id}'.`,
      })
    })
  })
  for (let leftIndex = 0; leftIndex < policy.externalMounts.length; leftIndex++) {
    const left = policy.externalMounts[leftIndex]!
    for (let rightIndex = leftIndex + 1; rightIndex < policy.externalMounts.length; rightIndex++) {
      const right = policy.externalMounts[rightIndex]!
      if (classifyAbsolutePosixPathRelationship(left.logicalPath, right.logicalPath) === 'disjoint') {
        continue
      }
      addIssue({
        code: 'custom',
        path: ['externalMounts', rightIndex, 'logicalPath'],
        message: `Snapshot capture-policy external mount boundaries '${left.blueprintVolumeName}' and '${right.blueprintVolumeName}' overlap.`,
      })
    }
  }
  const repositoryIndexes = new Map<string, number>()
  const repositoryLocationIndexes = new Map<string, number>()
  policy.gitRepositories.forEach((repository, index) => {
    const repositoryIndex = repositoryIndexes.get(repository.id)
    if (repositoryIndex !== undefined) {
      addIssue({
        code: 'custom',
        path: ['gitRepositories', index, 'id'],
        message: `Snapshot capture-policy Git repository ID '${repository.id}' is already declared at index ${repositoryIndex}.`,
      })
    } else {
      repositoryIndexes.set(repository.id, index)
    }
    const root = rootsById.get(repository.artifactRootId)
    if (!root) {
      addIssue({
        code: 'custom',
        path: ['gitRepositories', index, 'artifactRootId'],
        message: `Snapshot capture-policy Git repository references unknown artifact root '${repository.artifactRootId}'.`,
      })
      return
    }
    if (!isCanonicalRelativePosixPath(repository.path, true)) {
      addIssue({
        code: 'custom',
        path: ['gitRepositories', index, 'path'],
        message: `Snapshot capture-policy Git repository '${repository.id}' has a non-canonical relative path.`,
      })
      return
    }
    const expectedLogicalPath = joinAbsoluteAndRelativePosixPath(root.logicalPath, repository.path)
    if (repository.logicalPath !== expectedLogicalPath) {
      addIssue({
        code: 'custom',
        path: ['gitRepositories', index, 'logicalPath'],
        message: `Snapshot capture-policy Git repository '${repository.id}' has a logical path inconsistent with its artifact root and relative path.`,
      })
    }
    const location = `${repository.artifactRootId}\u0000${repository.path}`
    const locationIndex = repositoryLocationIndexes.get(location)
    if (locationIndex !== undefined) {
      addIssue({
        code: 'custom',
        path: ['gitRepositories', index, 'path'],
        message: `Snapshot capture-policy Git repository location '${repository.artifactRootId}:${repository.path}' is already declared at index ${locationIndex}.`,
      })
    } else {
      repositoryLocationIndexes.set(location, index)
    }
    const externalMount = policy.externalMounts.find(
      mount =>
        mount.artifactRootId === repository.artifactRootId &&
        classifyAbsolutePosixPathRelationship(repository.logicalPath, mount.logicalPath) !== 'disjoint',
    )
    if (externalMount) {
      addIssue({
        code: 'custom',
        path: ['gitRepositories', index, 'logicalPath'],
        message: `Snapshot capture-policy Git repository '${repository.id}' overlaps external mount '${externalMount.blueprintVolumeName}'.`,
      })
    }
    root.requiredPaths.forEach(requiredPath => {
      if (requiredPath.type !== 'file') {
        return
      }

      const absoluteRequiredPath = joinAbsoluteAndRelativePosixPath(root.logicalPath, requiredPath.path)
      if (!isEqualOrAncestorPath(absoluteRequiredPath, repository.logicalPath)) {
        return
      }
      addIssue({
        code: 'custom',
        path: ['gitRepositories', index, 'logicalPath'],
        message: `Snapshot capture-policy Git repository '${repository.id}' cannot equal or be nested beneath required file '${requiredPath.path}'.`,
      })
    })
    root.exclusions.forEach(exclusion => {
      const absoluteExclusionPath = joinAbsoluteAndRelativePosixPath(root.logicalPath, exclusion.path)
      if (!isEqualOrAncestorPath(absoluteExclusionPath, repository.logicalPath)) {
        return
      }
      addIssue({
        code: 'custom',
        path: ['gitRepositories', index, 'logicalPath'],
        message: `Snapshot capture-policy exclusion '${exclusion.path}' cannot equal or contain Git repository '${repository.id}'.`,
      })
    })
  })
  const capabilityIndexes = new Map<string, number>()
  policy.applicationCapabilities.forEach((capability, index) => {
    const capabilityIndex = capabilityIndexes.get(capability.application)
    if (capabilityIndex !== undefined) {
      addIssue({
        code: 'custom',
        path: ['applicationCapabilities', index, 'application'],
        message: `Snapshot capture-policy application '${capability.application}' is already declared at index ${capabilityIndex}.`,
      })
    } else {
      capabilityIndexes.set(capability.application, index)
    }
  })
}

export const CapsuleSnapshotCapturePolicyPinBodySchema = CapsuleSnapshotCapturePolicyFieldsSchema.superRefine(
  (policy, context) => {
    validateCapturePolicy(policy, issue => {
      context.addIssue({
        code: issue.code,
        path: issue.path,
        message: issue.message,
      })
    })
  },
)

export const CapsuleSnapshotCapturePolicyPinSchema = CapsuleSnapshotCapturePolicyFieldsSchema.extend({
  digest: CapsuleSnapshotCapturePolicyDigestSchema,
})
  .strict()
  .superRefine((policy, context) => {
    validateCapturePolicy(policy, issue => {
      context.addIssue({
        code: issue.code,
        path: issue.path,
        message: issue.message,
      })
    })
  })

/**
 * Client-safe reference to the complete server-side historical policy pin.
 */
export const CapsuleSnapshotCapturePolicyReferenceSchema = z
  .object({
    schemaVersion: CapsuleSnapshotCapturePolicyPinSchemaVersionSchema,
    digest: CapsuleSnapshotCapturePolicyDigestSchema,
  })
  .strict()

export type CapsuleSnapshotCapturePolicyDigest = z.infer<typeof CapsuleSnapshotCapturePolicyDigestSchema>
export type CapsuleSnapshotCapturePolicyArtifactRoot = z.infer<typeof CapsuleSnapshotCapturePolicyArtifactRootSchema>
export type CapsuleSnapshotCapturePolicyExternalMount = z.infer<typeof CapsuleSnapshotCapturePolicyExternalMountSchema>
export type CapsuleSnapshotCapturePolicyGitRepository = z.infer<typeof CapsuleSnapshotCapturePolicyGitRepositorySchema>
export type CapsuleSnapshotCapturePolicyPinBody = z.infer<typeof CapsuleSnapshotCapturePolicyPinBodySchema>
export type CapsuleSnapshotCapturePolicyPin = z.infer<typeof CapsuleSnapshotCapturePolicyPinSchema>
export type CapsuleSnapshotCapturePolicyReference = z.infer<typeof CapsuleSnapshotCapturePolicyReferenceSchema>
