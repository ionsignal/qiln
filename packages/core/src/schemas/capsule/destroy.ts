import { z } from 'zod'
import { CapsuleBlueprintDigestSchema } from '../blueprint/catalog'
import { CapsuleBlueprintIdentifierSchema } from '../blueprint/provision'
import { CapsuleRouteApplicationDigestSchema } from './routing/target'

export const CAPSULE_DESTROY_PLAN_VERSION = 1 as const

const ProviderIdentitySchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    value =>
      value.trim() === value &&
      value !== '.' &&
      value !== '..' &&
      !value.includes('/') &&
      !/[\u0000-\u001f\u007f]/.test(value),
    {
      message: 'Deletion targets require concrete provider identity components.',
    },
  )

const CaddyServerSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)

const CaddyRouteIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^qiln-(?:route-(?!fallback-)|preview-)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)

export const CapsuleDestroyDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export const CapsuleDestroyTimestampSchema = z.string().datetime({
  offset: true,
})

/**
 * Exact provider endpoints, independent from current deployment configuration.
 *
 * These identities describe deletion targets. Their shape or Qiln-looking name
 * does not independently establish ownership.
 */
export const CapsuleDestroyTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('instance'),
      provider: z.literal('incus'),
      project: ProviderIdentitySchema,
      instanceName: ProviderIdentitySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('volume'),
      provider: z.literal('incus'),
      project: ProviderIdentitySchema,
      pool: ProviderIdentitySchema,
      volumeName: ProviderIdentitySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('snapshot'),
      provider: z.literal('incus'),
      project: ProviderIdentitySchema,
      pool: ProviderIdentitySchema,
      volumeName: ProviderIdentitySchema,
      snapshotName: ProviderIdentitySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('route'),
      provider: z.literal('caddy'),
      server: CaddyServerSchema,
      routeId: CaddyRouteIdSchema,
    })
    .strict(),
])

/**
 * References the durable evidence used by the operation-specific proof reader.
 *
 * Parsing these references does not validate their database relationships,
 * historical Blueprint contents, provider markers, or restoration lineage. The
 * destroy proof boundary must independently establish those facts.
 */
export const CapsuleDestroyProofSchema = z.discriminatedUnion('source', [
  z
    .object({
      source: z.literal('branch'),
      branchId: z.uuid(),
      originOperationId: z.uuid(),
      originType: z.enum(['create', 'fork']),
      blueprintDigest: CapsuleBlueprintDigestSchema,
      inventoryDigest: CapsuleDestroyDigestSchema.nullable(),
      blueprintVolumeName: CapsuleBlueprintIdentifierSchema.nullable(),
    })
    .strict(),
  z
    .object({
      source: z.literal('snapshot'),
      branchId: z.uuid(),
      operationId: z.uuid(),
      createResourceId: z.uuid(),
      snapshotId: z.uuid().nullable(),
      blueprintVolumeName: CapsuleBlueprintIdentifierSchema,
    })
    .strict(),
  z
    .object({
      source: z.literal('preview'),
      previewId: z.uuid(),
      branchId: z.uuid(),
      applicationName: CapsuleBlueprintIdentifierSchema,
      applicationDigest: CapsuleRouteApplicationDigestSchema,
    })
    .strict(),
  z
    .object({
      source: z.literal('alias'),
      aliasId: z.uuid(),
    })
    .strict(),
])

export const CapsuleDestroyResourcePlanSchema = z
  .object({
    target: CapsuleDestroyTargetSchema,
    proof: CapsuleDestroyProofSchema,
  })
  .strict()
  .superRefine((resource, context) => {
    const { target, proof } = resource
    const valid =
      (target.kind === 'instance' && proof.source === 'branch' && proof.blueprintVolumeName === null) ||
      (target.kind === 'volume' && proof.source === 'branch' && proof.blueprintVolumeName !== null) ||
      (target.kind === 'snapshot' && proof.source === 'snapshot') ||
      (target.kind === 'route' &&
        ((proof.source === 'preview' && target.routeId.startsWith('qiln-preview-')) ||
          (proof.source === 'alias' && target.routeId.startsWith('qiln-route-'))))

    if (!valid) {
      context.addIssue({
        code: 'custom',
        path: ['proof'],
        message: 'Deletion target kind does not match its durable proof source.',
      })
    }
  })

export const CapsuleDestroyPlanSchema = z
  .object({
    schemaVersion: z.literal(CAPSULE_DESTROY_PLAN_VERSION),
    branchIds: z.array(z.uuid()).min(1),
    resources: z.array(CapsuleDestroyResourcePlanSchema),
  })
  .strict()
  .superRefine((plan, context) => {
    const branches = new Set(plan.branchIds)
    if (branches.size !== plan.branchIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['branchIds'],
        message: 'A destroy plan cannot contain duplicate branch identities.',
      })
    }
    plan.resources.forEach((resource, index) => {
      if ('branchId' in resource.proof && !branches.has(resource.proof.branchId)) {
        context.addIssue({
          code: 'custom',
          path: ['resources', index, 'proof', 'branchId'],
          message: 'Deletion proof references a branch outside the destroy plan.',
        })
      }
    })
  })

export const CapsuleDestroyResourceStatusValues = ['planned', 'deleting', 'absent', 'deleted', 'unresolved'] as const

export const CapsuleDestroyResourceStatusSchema = z.enum(CapsuleDestroyResourceStatusValues)

/**
 * An observation concerns the exact resource endpoint, not an asynchronous
 * provider-operation record.
 *
 * Absent requires a successful authoritative read or a validated provider
 * resource-not-found response. A timeout, missing operation record, malformed
 * response, or unavailable provider must remain unresolved.
 *
 * Details are server-only audit data. Callers must exclude secret values.
 */
export const CapsuleDestroyObservationSchema = z
  .object({
    target: CapsuleDestroyTargetSchema,
    state: z.enum(['present', 'absent', 'unresolved']),
    observedAt: CapsuleDestroyTimestampSchema,
    details: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()

export type CapsuleDestroyDigest = z.infer<typeof CapsuleDestroyDigestSchema>
export type CapsuleDestroyTarget = z.infer<typeof CapsuleDestroyTargetSchema>
export type CapsuleDestroyProof = z.infer<typeof CapsuleDestroyProofSchema>
export type CapsuleDestroyResourcePlan = z.infer<typeof CapsuleDestroyResourcePlanSchema>
export type CapsuleDestroyPlan = z.infer<typeof CapsuleDestroyPlanSchema>
export type CapsuleDestroyResourceStatus = z.infer<typeof CapsuleDestroyResourceStatusSchema>
export type CapsuleDestroyObservation = z.infer<typeof CapsuleDestroyObservationSchema>
