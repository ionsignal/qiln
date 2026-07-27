import { z, type ZodError } from 'zod'
import { GlobalError, GlobalErrorCode } from '../errors'
import {
  CapsuleBlueprintReferenceSchema,
  type CapsuleBlueprintDigest,
  type CapsuleBlueprintReference,
} from '../schemas/blueprint/catalog'
import {
  CapsuleBlueprintPinSchema,
  CapsuleBlueprintSchema,
  type CapsuleBlueprint,
  type CapsuleBlueprintPin,
} from '../schemas/blueprint/schema'
import { CapsuleBlueprintDigestSchema } from '../schemas/blueprint/catalog'
import { digestCanonicalJsonValue } from './canonical'

function validationDetails(error: ZodError): Record<string, unknown> {
  return {
    validation: z.treeifyError(error),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item)
    }
    Object.freeze(value)
    return value
  }
  if (isRecord(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child)
    }
    Object.freeze(value)
  }
  return value
}

/**
 * Produces the immutable digest of one validated capsule Blueprint.
 */
export function digestCapsuleBlueprint(value: unknown): CapsuleBlueprintDigest {
  const blueprint = CapsuleBlueprintSchema.safeParse(value)
  if (!blueprint.success) {
    throw new GlobalError(
      'Capsule Blueprint failed validation before digest generation.',
      GlobalErrorCode.BAD_REQUEST,
      validationDetails(blueprint.error),
    )
  }
  const digest = digestCanonicalJsonValue(blueprint.data, {
    context: `capsule Blueprint '${blueprint.data.name}'`,
  })
  const parsed = CapsuleBlueprintDigestSchema.safeParse(digest)
  if (!parsed.success) {
    throw new GlobalError(
      'Generated capsule Blueprint digest failed validation.',
      GlobalErrorCode.INTERNAL_ERROR,
      validationDetails(parsed.error),
    )
  }
  return parsed.data
}

/**
 * Validates a complete historical Blueprint pin and proves that its name and
 * digest match the embedded Blueprint snapshot.
 */
export function verifyCapsuleBlueprintPin(value: unknown): CapsuleBlueprintPin {
  const pin = CapsuleBlueprintPinSchema.safeParse(value)
  if (!pin.success) {
    throw new GlobalError(
      'Historical capsule Blueprint pin failed validation.',
      GlobalErrorCode.BAD_REQUEST,
      validationDetails(pin.error),
    )
  }
  if (pin.data.name !== pin.data.blueprint.name) {
    throw new GlobalError(
      'Historical capsule Blueprint pin name does not match its Blueprint snapshot.',
      GlobalErrorCode.CONFLICT,
      {
        pinName: pin.data.name,
        blueprintName: pin.data.blueprint.name,
      },
    )
  }
  const digest = digestCapsuleBlueprint(pin.data.blueprint)
  if (digest !== pin.data.digest) {
    throw new GlobalError(
      'Historical capsule Blueprint snapshot does not match its pinned digest.',
      GlobalErrorCode.CONFLICT,
      {
        blueprintName: pin.data.name,
        expectedDigest: pin.data.digest,
        actualDigest: digest,
      },
    )
  }
  return deepFreeze(pin.data)
}

/**
 * Creates a verified immutable Blueprint pin from a validated Blueprint and a
 * caller-reviewed digest.
 */
export function createCapsuleBlueprintPin(
  blueprint: CapsuleBlueprint,
  digest: CapsuleBlueprintDigest,
): CapsuleBlueprintPin {
  return verifyCapsuleBlueprintPin({
    name: blueprint.name,
    digest,
    blueprint,
  })
}

/**
 * Produces a client-safe Blueprint reference after verifying the complete
 * historical pin.
 */
export function createCapsuleBlueprintReference(value: unknown): CapsuleBlueprintReference {
  const pin = verifyCapsuleBlueprintPin(value)
  const reference = CapsuleBlueprintReferenceSchema.safeParse({
    schemaVersion: pin.blueprint.schema_version,
    name: pin.name,
    digest: pin.digest,
  })
  if (!reference.success) {
    throw new GlobalError(
      'Generated capsule Blueprint reference failed validation.',
      GlobalErrorCode.INTERNAL_ERROR,
      validationDetails(reference.error),
    )
  }
  return deepFreeze(reference.data)
}
