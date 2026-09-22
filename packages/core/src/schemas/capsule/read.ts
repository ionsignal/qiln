import { z } from 'zod'
import { CapsuleBlueprintReferenceSchema } from '../blueprint/catalog'
import { CapsuleBlueprintAbsolutePathSchema, CapsuleBlueprintIdentifierSchema } from '../blueprint/provision'
import { CapsuleBranchNameSchema, CapsuleBranchStatusSchema } from './branch'
import { CapsuleLifecycleStateSchema } from './lifecycle'
import { CapsuleOperationStatus, CapsuleOperationSummarySchema } from './operations'
import { CapsuleRootfsImageFingerprintSchema } from './rootfs'
import { CapsuleBranchPreviewStatusSchema } from './routing/preview'
import { CapsuleRouteEvidenceTimestampSchema } from './routing/evidence'

/**
 * Client-safe branch identity within a capsule.
 *
 * Worker reads must independently prove capsule ownership and branch
 * membership. Branch names are display identities, not capsule names or
 * provider identities.
 */
export const CapsuleBranchIdentitySchema = z
  .object({
    id: z.uuid(),
    name: CapsuleBranchNameSchema,
    isRootBranch: z.boolean(),
  })
  .strict()

export const CapsuleRootBranchIdentitySchema = CapsuleBranchIdentitySchema.extend({
  isRootBranch: z.literal(true),
}).strict()

/**
 * Durable branch runtime projection without a live provider observation.
 *
 * Present runtimeIp as "Recorded runtime IP". No observation timestamp is
 * persisted, and an online branch may legitimately have no recorded address.
 * Raw runtime errors and provider diagnostics remain server-side.
 */
export const CapsuleBranchRuntimeSchema = CapsuleBranchIdentitySchema.extend({
  status: CapsuleBranchStatusSchema,
  runtimeIp: z.string().min(1).nullable(),
}).strict()

export const CapsuleRootBranchRuntimeSchema = CapsuleBranchRuntimeSchema.extend({
  isRootBranch: z.literal(true),
}).strict()

/**
 * Capsule-wide current operation, not necessarily an operation targeting the
 * selected branch. Terminal operations belong to activity history instead.
 */
export const CapsuleCurrentOperationSchema = CapsuleOperationSummarySchema.extend({
  status: z.enum([CapsuleOperationStatus.ACCEPTED, CapsuleOperationStatus.RUNNING]),
}).strict()

/**
 * Historical GPU configuration only.
 *
 * DeviceCount counts Blueprint runtime.devices entries whose type is gpu. It
 * does not count physical GPUs or prove allocation, availability, or health.
 */
export const CapsuleGpuDeclarationSchema = z
  .object({
    configured: z.boolean(),
    deviceCount: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((gpu, context) => {
    if (gpu.configured !== gpu.deviceCount > 0) {
      context.addIssue({
        code: 'custom',
        path: ['configured'],
        message: 'GPU configuration must agree with the number of declared GPU device entries.',
      })
    }
  })

const CapsuleStorageBoundaryFieldsSchema = z
  .object({
    name: CapsuleBlueprintIdentifierSchema,
    mountPath: CapsuleBlueprintAbsolutePathSchema,
    readonly: z.boolean(),
  })
  .strict()

/**
 * Declared storage boundaries derived from the historical Blueprint.
 *
 * MountPath is a path inside the capsule, never a host path. These declarations
 * do not prove live mount health or provider availability. A read-only clone is
 * a read-only baseline clone, not a live shared model vault.
 */
export const CapsuleStorageBoundarySchema = z.discriminatedUnion('kind', [
  CapsuleStorageBoundaryFieldsSchema.extend({
    kind: z.literal('clone'),
    versioning: z.literal('versioned'),
  }).strict(),
  CapsuleStorageBoundaryFieldsSchema.extend({
    kind: z.literal('empty'),
    versioning: z.enum(['versioned', 'unversioned']),
  }).strict(),
  CapsuleStorageBoundaryFieldsSchema.extend({
    kind: z.literal('bind'),
    versioning: z.literal('external'),
  }).strict(),
])

/**
 * Allowlisted historical capsule anatomy.
 *
 * Worker projection verifies immutable branch provenance before exposing these
 * fields. Full Blueprint configuration, image project and alias, device
 * configuration, storage provider identities, and host paths remain private.
 */
export const CapsulePinnedManifestSchema = z
  .object({
    blueprint: CapsuleBlueprintReferenceSchema,
    rootfsImageFingerprint: CapsuleRootfsImageFingerprintSchema,
    cpu: z.string().trim().min(1),
    memory: z.string().trim().min(1),
    gpu: CapsuleGpuDeclarationSchema,
    applicationCount: z.number().int().nonnegative(),
    storageBoundaries: z.array(CapsuleStorageBoundarySchema),
  })
  .strict()

export const CapsuleManifestUnavailableReason = {
  CREATION_NOT_COMPLETED: 'creation_not_completed',
  HISTORICAL_EVIDENCE_UNAVAILABLE: 'historical_evidence_unavailable',
} as const

export type CapsuleManifestUnavailableReason =
  (typeof CapsuleManifestUnavailableReason)[keyof typeof CapsuleManifestUnavailableReason]

export const CapsuleManifestUnavailableReasonValues = [
  CapsuleManifestUnavailableReason.CREATION_NOT_COMPLETED,
  CapsuleManifestUnavailableReason.HISTORICAL_EVIDENCE_UNAVAILABLE,
] as const

export const CapsuleManifestUnavailableReasonSchema = z.enum(CapsuleManifestUnavailableReasonValues)

/**
 * Keeps detail inspectable when completed historical provenance is unavailable.
 *
 * An unavailable manifest is not an empty declaration. Worker readers must not
 * convert arbitrary database or transport failures into an unavailable result.
 */
export const CapsuleManifestSchema = z.discriminatedUnion('available', [
  z
    .object({
      available: z.literal(true),
      manifest: CapsulePinnedManifestSchema,
    })
    .strict(),
  z
    .object({
      available: z.literal(false),
      reason: CapsuleManifestUnavailableReasonSchema,
    })
    .strict(),
])

function isPublicPreviewUrl(value: string): boolean {
  if (value.trim() !== value || /[\u0000-\u0020\u007f\\]/.test(value)) {
    return false
  }
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      value.startsWith(`${url.protocol}//`) &&
      url.hostname !== '' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    )
  } catch {
    return false
  }
}

/**
 * Explicit browser URL issued by the Worker, never derived by Vue.
 *
 * This validates URL shape only. Worker construction must bind the configured
 * public scheme and port to the validated durable preview host and a safe
 * historical application entrypoint.
 */
export const CapsulePreviewUrlSchema = z.string().refine(isPublicPreviewUrl, {
  message: 'Preview URLs must be absolute HTTP(S) URLs without credentials, query, fragment, or unsafe characters.',
})

/**
 * Reduced preview projection for capsule reads.
 *
 * Active status requires Worker-verified application provenance, positive
 * upstream and route evidence, and agreement with current configuration. Schema
 * validation alone cannot establish those facts.
 *
 * An active preview may have no URL while lifecycle, runtime, or withdrawal
 * state makes it ineligible to open. Its persisted routing status is preserved
 * rather than replaced with an invented transition.
 *
 * Non-active previews may retain a historical verification timestamp, but never
 * expose an openable URL.
 */
export const CapsulePreviewSchema = z
  .object({
    id: z.uuid(),
    applicationName: CapsuleBlueprintIdentifierSchema,
    status: CapsuleBranchPreviewStatusSchema,
    verifiedAt: CapsuleRouteEvidenceTimestampSchema.nullable(),
    previewUrl: CapsulePreviewUrlSchema.nullable(),
  })
  .strict()
  .superRefine((preview, context) => {
    if (preview.status === 'active') {
      if (preview.verifiedAt === null) {
        context.addIssue({
          code: 'custom',
          path: ['verifiedAt'],
          message: 'An active preview requires a verification timestamp.',
        })
      }
      return
    }
    if (preview.previewUrl !== null) {
      context.addIssue({
        code: 'custom',
        path: ['previewUrl'],
        message: 'Only an active verified preview may expose a browser URL.',
      })
    }
  })

/**
 * One owned capsule in the unpaginated demo index.
 *
 * Archived and destroyed capsules remain visible. Root identity is required;
 * missing or multiple roots are integrity errors rather than nullable state.
 * Previews belong to the root branch. Lifecycle, runtime, preview, and current
 * operation state remain separate rather than implying a combined status.
 *
 * Null previews mean historical application provenance is unavailable. An empty
 * array means no preview records exist, not that verification failed.
 */
export const CapsuleSummarySchema = z
  .object({
    capsule: CapsuleLifecycleStateSchema,
    rootBranch: CapsuleRootBranchRuntimeSchema,
    previews: z.array(CapsulePreviewSchema).nullable(),
    currentOperation: CapsuleCurrentOperationSchema.nullable(),
  })
  .strict()

export const CapsuleListOutputSchema = z.array(CapsuleSummarySchema)

/**
 * Capsule detail for one explicitly selected branch, defaulting to the root.
 *
 * Worker reads must reject an invalid explicit branch selector rather than
 * silently falling back. Manifest and previews describe only the selected
 * branch; currentOperation remains capsule-wide.
 *
 * Null previews mean historical application provenance is unavailable. An empty
 * array means no preview records exist, not that verification failed.
 */
export const CapsuleDetailSchema = z
  .object({
    capsule: CapsuleLifecycleStateSchema,
    rootBranch: CapsuleRootBranchIdentitySchema,
    branch: CapsuleBranchRuntimeSchema,
    manifest: CapsuleManifestSchema,
    previews: z.array(CapsulePreviewSchema).nullable(),
    currentOperation: CapsuleCurrentOperationSchema.nullable(),
  })
  .strict()

export type CapsuleBranchIdentity = z.infer<typeof CapsuleBranchIdentitySchema>
export type CapsuleRootBranchIdentity = z.infer<typeof CapsuleRootBranchIdentitySchema>
export type CapsuleBranchRuntime = z.infer<typeof CapsuleBranchRuntimeSchema>
export type CapsuleRootBranchRuntime = z.infer<typeof CapsuleRootBranchRuntimeSchema>
export type CapsuleCurrentOperation = z.infer<typeof CapsuleCurrentOperationSchema>
export type CapsuleGpuDeclaration = z.infer<typeof CapsuleGpuDeclarationSchema>
export type CapsuleStorageBoundary = z.infer<typeof CapsuleStorageBoundarySchema>
export type CapsulePinnedManifest = z.infer<typeof CapsulePinnedManifestSchema>
export type CapsuleManifest = z.infer<typeof CapsuleManifestSchema>
export type CapsulePreviewUrl = z.infer<typeof CapsulePreviewUrlSchema>
export type CapsulePreview = z.infer<typeof CapsulePreviewSchema>
export type CapsuleSummary = z.infer<typeof CapsuleSummarySchema>
export type CapsuleListOutput = z.infer<typeof CapsuleListOutputSchema>
export type CapsuleDetail = z.infer<typeof CapsuleDetailSchema>
