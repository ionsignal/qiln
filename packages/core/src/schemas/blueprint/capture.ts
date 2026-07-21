import { z } from 'zod'
import { CapsuleArtifactRootIdSchema } from '../capsule/artifact/entry'
import { containsPosixPathSegment, isCanonicalRelativePosixPath } from '../posix'
import { CapsuleBlueprintIdentifierSchema } from './provision'

export const CAPSULE_SNAPSHOT_CAPTURE_POLICY_VERSION = 1 as const

const CapsuleBlueprintRequiredRelativePathSchema = z.string().refine(value => isCanonicalRelativePosixPath(value, false), {
  message: "Required artifact paths must be canonical relative POSIX paths and cannot be '.'.",
})

const CapsuleBlueprintRepositoryRelativePathSchema = z
  .string()
  .refine(value => isCanonicalRelativePosixPath(value, true), {
    message: "Git repository paths must be canonical relative POSIX paths; use '.' for the artifact root itself.",
  })
  .refine(value => !containsPosixPathSegment(value, '.git'), {
    message: "Git repository paths cannot identify or traverse a '.git' administrative path.",
  })

export const CapsuleBlueprintArtifactRequiredPathSchema = z
  .object({
    path: CapsuleBlueprintRequiredRelativePathSchema,
    type: z.enum(['file', 'directory']),
  })
  .strict()

/**
 * One Qiln-managed filesystem root included in canonical artifact collection.
 *
 * `volume` references a stable provisioning volume name. The root's logical
 * path is derived from that volume's `mount_path`, preventing duplicate path
 * declarations from drifting apart.
 */
export const CapsuleBlueprintArtifactRootSchema = z
  .object({
    id: CapsuleArtifactRootIdSchema,
    volume: CapsuleBlueprintIdentifierSchema,
    required: z.boolean().default(true),
    required_paths: z.array(CapsuleBlueprintArtifactRequiredPathSchema).default([]),
  })
  .strict()

/**
 * Declares a bind mount nested strictly beneath a managed artifact root.
 *
 * External mounts are capture boundaries rather than ordinary exclusions. A
 * collector must not traverse their contents as canonical artifact entries.
 *
 * A required external mount requires an immutable dependency reference before
 * capture may commit. Read-only mount configuration alone is not proof that the
 * mounted state is immutable.
 */
export const CapsuleBlueprintExternalMountSchema = z
  .object({
    volume: CapsuleBlueprintIdentifierSchema,
    required: z.boolean().default(true),
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

export const CapsuleBlueprintSnapshotCapturePolicySchema = z
  .object({
    policy_version: z.literal(CAPSULE_SNAPSHOT_CAPTURE_POLICY_VERSION),
    artifact_roots: z.array(CapsuleBlueprintArtifactRootSchema).min(1),
    external_mounts: z.array(CapsuleBlueprintExternalMountSchema).default([]),
    git_repositories: z.array(CapsuleBlueprintGitRepositorySchema).default([]),
  })
  .strict()

export type CapsuleBlueprintArtifactRequiredPath = z.infer<typeof CapsuleBlueprintArtifactRequiredPathSchema>
export type CapsuleBlueprintArtifactRoot = z.infer<typeof CapsuleBlueprintArtifactRootSchema>
export type CapsuleBlueprintExternalMount = z.infer<typeof CapsuleBlueprintExternalMountSchema>
export type CapsuleBlueprintGitRepository = z.infer<typeof CapsuleBlueprintGitRepositorySchema>
export type CapsuleBlueprintSnapshotCapturePolicy = z.infer<typeof CapsuleBlueprintSnapshotCapturePolicySchema>
