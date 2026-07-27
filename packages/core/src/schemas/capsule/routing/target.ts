import { z } from 'zod'
import { CapsuleBlueprintApplicationSchema } from '../../blueprint/application'
import { CapsuleBlueprintReferenceSchema } from '../../blueprint/catalog'
import { CapsuleSnapshotAssuranceSchema } from '../snapshot/mode'

export const CAPSULE_ROUTE_APPLICATION_PIN_SCHEMA_VERSION = 1 as const
export const CAPSULE_ROUTE_TARGET_PIN_SCHEMA_VERSION = 1 as const

export const CapsuleRouteApplicationDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/, {
  message: "Route application digests must use the format 'sha256:<64 lowercase hex characters>'.",
})

export const CapsuleRouteTargetDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/, {
  message: "Route target digests must use the format 'sha256:<64 lowercase hex characters>'.",
})

export const CapsuleRouteApplicationPinBodySchema = z
  .object({
    schemaVersion: z.literal(CAPSULE_ROUTE_APPLICATION_PIN_SCHEMA_VERSION),
    blueprint: CapsuleBlueprintReferenceSchema,
    application: CapsuleBlueprintApplicationSchema,
  })
  .strict()
  .superRefine((pin, context) => {
    if (pin.application.exposure !== 'proxy') {
      context.addIssue({
        code: 'custom',
        path: ['application', 'exposure'],
        message: `Application '${pin.application.name}' is internal and cannot be pinned as a route target.`,
      })
    }
  })

export const CapsuleRouteApplicationPinSchema = CapsuleRouteApplicationPinBodySchema.safeExtend({
  digest: CapsuleRouteApplicationDigestSchema,
}).strict()

export const CapsuleRouteTargetPinBodySchema = z
  .object({
    schemaVersion: z.literal(CAPSULE_ROUTE_TARGET_PIN_SCHEMA_VERSION),
    snapshotId: z.uuid(),
    application: CapsuleRouteApplicationPinSchema,
    assurance: CapsuleSnapshotAssuranceSchema,
  })
  .strict()

export const CapsuleRouteTargetPinSchema = CapsuleRouteTargetPinBodySchema.extend({
  digest: CapsuleRouteTargetDigestSchema,
}).strict()

/**
 * Client-safe immutable target reference.
 *
 * Full Blueprint application configuration remains server-side. Committed route
 * reads expose only the application identity, snapshot assurance, and verified
 * target digest.
 */
export const CapsuleRouteTargetReferenceSchema = z
  .object({
    schemaVersion: z.literal(CAPSULE_ROUTE_TARGET_PIN_SCHEMA_VERSION),
    digest: CapsuleRouteTargetDigestSchema,
    snapshotId: z.uuid(),
    blueprint: CapsuleBlueprintReferenceSchema,
    applicationName: z.string(),
    assurance: CapsuleSnapshotAssuranceSchema,
  })
  .strict()

export type CapsuleRouteApplicationDigest = z.infer<typeof CapsuleRouteApplicationDigestSchema>
export type CapsuleRouteTargetDigest = z.infer<typeof CapsuleRouteTargetDigestSchema>
export type CapsuleRouteApplicationPinBody = z.infer<typeof CapsuleRouteApplicationPinBodySchema>
export type CapsuleRouteApplicationPin = z.infer<typeof CapsuleRouteApplicationPinSchema>
export type CapsuleRouteTargetPinBody = z.infer<typeof CapsuleRouteTargetPinBodySchema>
export type CapsuleRouteTargetPin = z.infer<typeof CapsuleRouteTargetPinSchema>
export type CapsuleRouteTargetReference = z.infer<typeof CapsuleRouteTargetReferenceSchema>
