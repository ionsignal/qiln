import { z } from 'zod'

export const DEFAULT_CAPSULE_BLUEPRINT_NAME = 'n8n-comfyui-capsule'

export const CapsuleBlueprintDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/, {
  message: "Capsule blueprint digests must use the format 'sha256:<64 lowercase hex characters>'.",
})

export const CapsuleBlueprintReferenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string(),
    digest: CapsuleBlueprintDigestSchema,
  })
  .strict()

/**
 * Client-safe blueprint catalog item.
 *
 * Full provisioning and capture-policy details remain server-side.
 */
export const CapsuleBlueprintManifestItemSchema = z
  .object({
    name: z.string(),
    displayName: z.string(),
    description: z.string(),
    digest: CapsuleBlueprintDigestSchema,
  })
  .strict()

export const CapsuleBlueprintManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    catalogDigest: CapsuleBlueprintDigestSchema,
    blueprints: z.array(CapsuleBlueprintManifestItemSchema),
  })
  .strict()

export type CapsuleBlueprintDigest = z.infer<typeof CapsuleBlueprintDigestSchema>
export type CapsuleBlueprintReference = z.infer<typeof CapsuleBlueprintReferenceSchema>
export type CapsuleBlueprintManifestItem = z.infer<typeof CapsuleBlueprintManifestItemSchema>
export type CapsuleBlueprintManifest = z.infer<typeof CapsuleBlueprintManifestSchema>
