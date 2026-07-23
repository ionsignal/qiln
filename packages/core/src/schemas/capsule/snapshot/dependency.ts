import { z } from 'zod'
import { CapsuleBlueprintIdentifierSchema } from '../../blueprint/provision'
import { CapsuleArtifactRootIdSchema } from '../artifact/entry'

export const CapsuleSnapshotDependencyKind = {
  MODEL_VAULT: 'model_vault',
} as const

export type CapsuleSnapshotDependencyKind =
  (typeof CapsuleSnapshotDependencyKind)[keyof typeof CapsuleSnapshotDependencyKind]

export const CapsuleSnapshotDependencyKindValues = [CapsuleSnapshotDependencyKind.MODEL_VAULT] as const

export const CapsuleSnapshotDependencyKindSchema = z.enum(CapsuleSnapshotDependencyKindValues)

/**
 * Stable dependency identity declared by the historical capture-policy pin.
 *
 * This declaration intentionally contains no live resolver state, immutable
 * revision, credentials, provider paths, or secret values.
 */
export const CapsuleSnapshotDependencyDeclarationSchema = z
  .object({
    kind: z.literal(CapsuleSnapshotDependencyKind.MODEL_VAULT),
    logicalId: CapsuleBlueprintIdentifierSchema,
  })
  .strict()

export const CapsuleSnapshotDependencyDigestKind = {
  CONTENT: 'content',
  CATALOG: 'catalog',
} as const

export type CapsuleSnapshotDependencyDigestKind =
  (typeof CapsuleSnapshotDependencyDigestKind)[keyof typeof CapsuleSnapshotDependencyDigestKind]

export const CapsuleSnapshotDependencyDigestKindValues = [
  CapsuleSnapshotDependencyDigestKind.CONTENT,
  CapsuleSnapshotDependencyDigestKind.CATALOG,
] as const

export const CapsuleSnapshotDependencyDigestKindSchema = z.enum(CapsuleSnapshotDependencyDigestKindValues)

export const CapsuleSnapshotDependencyDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/, {
  message: "Snapshot dependency digests must use the format 'sha256:<64 lowercase hex characters>'.",
})

export const CapsuleSnapshotDependencyDigestReferenceSchema = z
  .object({
    kind: CapsuleSnapshotDependencyDigestKindSchema,
    digest: CapsuleSnapshotDependencyDigestSchema,
  })
  .strict()

/**
 * Immutable external dependency evidence attached to a committed snapshot.
 *
 * The durable database record additionally retains snapshot and source
 * branch-resource provenance. This domain contract describes the validated
 * evidence that the future capture transaction must persist.
 */
export const CapsuleSnapshotDependencyReferenceSchema = CapsuleSnapshotDependencyDeclarationSchema.extend({
  artifactRootId: CapsuleArtifactRootIdSchema,
  blueprintVolumeName: CapsuleBlueprintIdentifierSchema,
  revision: z.string().trim().min(1).max(512),
  content: CapsuleSnapshotDependencyDigestReferenceSchema,
}).strict()

export type CapsuleSnapshotDependencyDeclaration = z.infer<typeof CapsuleSnapshotDependencyDeclarationSchema>
export type CapsuleSnapshotDependencyDigest = z.infer<typeof CapsuleSnapshotDependencyDigestSchema>
export type CapsuleSnapshotDependencyDigestReference = z.infer<typeof CapsuleSnapshotDependencyDigestReferenceSchema>
export type CapsuleSnapshotDependencyReference = z.infer<typeof CapsuleSnapshotDependencyReferenceSchema>
