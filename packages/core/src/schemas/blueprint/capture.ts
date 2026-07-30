import { z } from 'zod'
import { CapsuleArtifactRootIdSchema } from '../capsule/artifact/entry'
import { containsPosixPathSegment, isCanonicalRelativePosixPath } from '../posix'
import { CapsuleBlueprintIdentifierSchema } from './provision'

export const CAPSULE_SNAPSHOT_CAPTURE_POLICY_VERSION = 1 as const

const CapsuleBlueprintArtifactRelativePathSchema = z
  .string()
  .refine(value => isCanonicalRelativePosixPath(value, false), {
    message: "Artifact paths must be canonical relative POSIX paths and cannot be '.'.",
  })
  .refine(value => !containsPosixPathSegment(value, '.git'), {
    message: "Artifact paths cannot identify or traverse a '.git' administrative path.",
  })

export const CapsuleBlueprintRepositoryRelativePathSchema = z
  .string()
  .refine(value => isCanonicalRelativePosixPath(value, true), {
    message: "Git repository paths must be canonical relative POSIX paths; use '.' for the artifact root itself.",
  })
  .refine(value => !containsPosixPathSegment(value, '.git'), {
    message: "Git repository paths cannot identify or traverse a '.git' administrative path.",
  })

export const CapsuleBlueprintArtifactRequiredPathSchema = z
  .object({
    path: CapsuleBlueprintArtifactRelativePathSchema,
    type: z.enum(['file', 'directory']),
  })
  .strict()

export const CapsuleBlueprintArtifactExclusionReason = {
  RUNTIME_ONLY: 'runtime_only',
  REBUILDABLE: 'rebuildable',
} as const

export type CapsuleBlueprintArtifactExclusionReason =
  (typeof CapsuleBlueprintArtifactExclusionReason)[keyof typeof CapsuleBlueprintArtifactExclusionReason]

export const CapsuleBlueprintArtifactExclusionReasonValues = [
  CapsuleBlueprintArtifactExclusionReason.RUNTIME_ONLY,
  CapsuleBlueprintArtifactExclusionReason.REBUILDABLE,
] as const

export const CapsuleBlueprintArtifactExclusionReasonSchema = z.enum(CapsuleBlueprintArtifactExclusionReasonValues)

/**
 * Explicitly excludes a non-canonical path from collection beneath one managed
 * artifact root.
 *
 * Exclusions affect the canonical artifact manifest only. They do not remove
 * data from physical provider snapshots, so secret material must not be
 * represented as an exclusion.
 */
export const CapsuleBlueprintArtifactExclusionSchema = z
  .object({
    path: CapsuleBlueprintArtifactRelativePathSchema,
    type: z.enum(['file', 'directory']),
    reason: CapsuleBlueprintArtifactExclusionReasonSchema,
    required: z.boolean().default(false),
  })
  .strict()

/**
 * One Qiln-managed filesystem root included in canonical artifact collection.
 *
 * Every managed clone or empty volume must resolve to exactly one required
 * artifact root. `volume` references the stable provisioning volume name and
 * the root logical path is derived from that volume's `mount_path`.
 */
export const CapsuleBlueprintArtifactRootSchema = z
  .object({
    id: CapsuleArtifactRootIdSchema,
    volume: CapsuleBlueprintIdentifierSchema,
    required: z.literal(true).default(true),
    required_paths: z.array(CapsuleBlueprintArtifactRequiredPathSchema).default([]),
    exclusions: z.array(CapsuleBlueprintArtifactExclusionSchema).default([]),
  })
  .strict()

export const CapsuleBlueprintInstanceRootfsMode = {
  REBUILDABLE: 'rebuildable',
} as const

export type CapsuleBlueprintInstanceRootfsMode =
  (typeof CapsuleBlueprintInstanceRootfsMode)[keyof typeof CapsuleBlueprintInstanceRootfsMode]

export const CapsuleBlueprintInstanceRootfsModeValues = [CapsuleBlueprintInstanceRootfsMode.REBUILDABLE] as const
export const CapsuleBlueprintInstanceRootfsModeSchema = z.enum(CapsuleBlueprintInstanceRootfsModeValues)

/**
 * Declares how instance rootfs state is handled by Snapshot Capture and fork.
 *
 * V1 supports only rebuildable rootfs state. A fork recreates the instance from
 * the pinned image, runtime configuration, and provisioning files. Mutable
 * capsule state must therefore live in managed artifact-root volumes.
 */
export const CapsuleBlueprintInstanceRootfsSchema = z
  .object({
    mode: z.literal(CapsuleBlueprintInstanceRootfsMode.REBUILDABLE),
  })
  .strict()

export const CapsuleBlueprintExternalMountDependencyKind = {
  MODEL_VAULT: 'model_vault',
} as const

export type CapsuleBlueprintExternalMountDependencyKind =
  (typeof CapsuleBlueprintExternalMountDependencyKind)[keyof typeof CapsuleBlueprintExternalMountDependencyKind]

export const CapsuleBlueprintModelVaultDependencySchema = z
  .object({
    kind: z.literal(CapsuleBlueprintExternalMountDependencyKind.MODEL_VAULT),
    logical_id: CapsuleBlueprintIdentifierSchema,
  })
  .strict()

/**
 * Declares the resolver identity for one external capture dependency.
 *
 * The blueprint stores only a stable logical identity. Snapshot capture must
 * later resolve and persist the immutable vault revision and content/catalog
 * digest separately from this mutable policy declaration.
 */
export const CapsuleBlueprintExternalMountDependencySchema = CapsuleBlueprintModelVaultDependencySchema

/**
 * Declares a bind mount nested strictly beneath a managed artifact root.
 *
 * External mounts are capture boundaries rather than ordinary exclusions. A
 * collector must not traverse their contents as canonical artifact entries.
 *
 * Every external mount has exactly one logical dependency declaration. One
 * logical dependency identity may belong to only one external mount boundary
 * within a capture policy.
 *
 * A required external mount requires an immutable dependency reference before
 * capture may commit. Read-only mount configuration alone is not proof that the
 * mounted state is immutable.
 */
export const CapsuleBlueprintExternalMountSchema = z
  .object({
    volume: CapsuleBlueprintIdentifierSchema,
    required: z.boolean().default(true),
    dependency: CapsuleBlueprintExternalMountDependencySchema,
  })
  .strict()

/**
 * Declares one normal Git repository whose working tree remains represented by
 * the canonical filesystem manifest.
 *
 * Declared repositories may be strictly nested. This supports independently
 * managed custom-node or extension repositories inside a parent application
 * repository. Every nested repository must be explicitly declared and receives
 * its own future semantic Git record.
 *
 * A future collector must reject bare repositories, worktrees, `.git` files,
 * submodules, undeclared nested repositories, unsupported LFS restoration, and
 * unsupported Git structures. Git administrative content must not become
 * ordinary artifact entries.
 */
export const CapsuleBlueprintGitRepositorySchema = z
  .object({
    id: CapsuleBlueprintIdentifierSchema,
    artifact_root_id: CapsuleArtifactRootIdSchema,
    path: CapsuleBlueprintRepositoryRelativePathSchema,
    required: z.boolean().default(true),
  })
  .strict()

export const CapsuleBlueprintSnapshotCaptureApplicationSupport = {
  ARTIFACT_CAPTURE: 'artifact_capture',
  EVALUATION_ONLY: 'evaluation_only',
  ROUTE_RUNTIME: 'route_runtime',
} as const

export type CapsuleBlueprintSnapshotCaptureApplicationSupport =
  (typeof CapsuleBlueprintSnapshotCaptureApplicationSupport)[keyof typeof CapsuleBlueprintSnapshotCaptureApplicationSupport]

export const CapsuleBlueprintSnapshotCaptureApplicationSupportValues = [
  CapsuleBlueprintSnapshotCaptureApplicationSupport.ARTIFACT_CAPTURE,
  CapsuleBlueprintSnapshotCaptureApplicationSupport.EVALUATION_ONLY,
  CapsuleBlueprintSnapshotCaptureApplicationSupport.ROUTE_RUNTIME,
] as const

export const CapsuleBlueprintSnapshotCaptureApplicationSupportSchema = z.enum(
  CapsuleBlueprintSnapshotCaptureApplicationSupportValues,
)

/**
 * Makes application-specific snapshot-capture limits explicit in the pinned
 * blueprint policy.
 *
 * `artifact_capture` permits canonical filesystem capture only; it does not
 * claim runtime reconstruction, promotion, credential handling, or runtime
 * export/import support. `evaluation_only` further limits capture output to
 * non-production evaluation. `route_runtime` permits a future promote or
 * rollback operation to reconstruct the application into an internal runtime.
 */
export const CapsuleBlueprintSnapshotCaptureApplicationCapabilitySchema = z
  .object({
    application: CapsuleBlueprintIdentifierSchema,
    support: CapsuleBlueprintSnapshotCaptureApplicationSupportSchema,
  })
  .strict()

export const CapsuleBlueprintSnapshotCapturePolicySchema = z
  .object({
    policy_version: z.literal(CAPSULE_SNAPSHOT_CAPTURE_POLICY_VERSION),
    instance_rootfs: CapsuleBlueprintInstanceRootfsSchema,
    artifact_roots: z.array(CapsuleBlueprintArtifactRootSchema).min(1),
    external_mounts: z.array(CapsuleBlueprintExternalMountSchema).default([]),
    git_repositories: z.array(CapsuleBlueprintGitRepositorySchema).default([]),
    application_capabilities: z.array(CapsuleBlueprintSnapshotCaptureApplicationCapabilitySchema).min(1),
  })
  .strict()

export type CapsuleBlueprintArtifactRequiredPath = z.infer<typeof CapsuleBlueprintArtifactRequiredPathSchema>
export type CapsuleBlueprintArtifactExclusion = z.infer<typeof CapsuleBlueprintArtifactExclusionSchema>
export type CapsuleBlueprintArtifactRoot = z.infer<typeof CapsuleBlueprintArtifactRootSchema>
export type CapsuleBlueprintInstanceRootfs = z.infer<typeof CapsuleBlueprintInstanceRootfsSchema>
export type CapsuleBlueprintModelVaultDependency = z.infer<typeof CapsuleBlueprintModelVaultDependencySchema>
export type CapsuleBlueprintExternalMountDependency = z.infer<typeof CapsuleBlueprintExternalMountDependencySchema>
export type CapsuleBlueprintExternalMount = z.infer<typeof CapsuleBlueprintExternalMountSchema>
export type CapsuleBlueprintGitRepository = z.infer<typeof CapsuleBlueprintGitRepositorySchema>
export type CapsuleBlueprintSnapshotCaptureApplicationCapability = z.infer<
  typeof CapsuleBlueprintSnapshotCaptureApplicationCapabilitySchema
>
export type CapsuleBlueprintSnapshotCapturePolicy = z.infer<typeof CapsuleBlueprintSnapshotCapturePolicySchema>
