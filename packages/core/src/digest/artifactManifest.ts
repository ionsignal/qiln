import { z, type ZodError } from 'zod'
import { GlobalError, GlobalErrorCode } from '../errors'
import {
  CapsuleArtifactManifestDigestSchema,
  CapsuleArtifactManifestReferenceSchema,
  type CapsuleArtifactManifestDigest,
  type CapsuleArtifactManifestReference,
} from '../schemas/capsule/artifact/reference'
import {
  CapsuleArtifactManifestSchema,
  type CapsuleArtifactManifest,
  type CapsuleArtifactManifestRoot,
} from '../schemas/capsule/artifact/manifest'
import type { CapsuleArtifactEntry } from '../schemas/capsule/artifact/entry'
import { digestCanonicalJsonValue } from './canonical'

function validationDetails(error: ZodError): Record<string, unknown> {
  return {
    validation: z.treeifyError(error),
  }
}

function compareCanonicalString(left: string, right: string): number {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}

function compareManifestRoots(left: CapsuleArtifactManifestRoot, right: CapsuleArtifactManifestRoot): number {
  const idComparison = compareCanonicalString(left.id, right.id)
  return idComparison === 0 ? compareCanonicalString(left.logicalPath, right.logicalPath) : idComparison
}

function compareManifestEntries(left: CapsuleArtifactEntry, right: CapsuleArtifactEntry): number {
  const rootComparison = compareCanonicalString(left.rootId, right.rootId)
  if (rootComparison !== 0) {
    return rootComparison
  }
  const pathComparison = compareCanonicalString(left.logicalPath, right.logicalPath)
  if (pathComparison !== 0) {
    return pathComparison
  }
  return compareCanonicalString(left.type, right.type)
}

function digestNormalizedCapsuleArtifactManifest(manifest: CapsuleArtifactManifest): CapsuleArtifactManifestDigest {
  const digest = digestCanonicalJsonValue(manifest, {
    context: 'capsule artifact manifest',
  })
  const parsedDigest = CapsuleArtifactManifestDigestSchema.safeParse(digest)
  if (!parsedDigest.success) {
    throw new GlobalError(
      'Generated capsule artifact manifest digest failed validation.',
      GlobalErrorCode.INTERNAL_ERROR,
      validationDetails(parsedDigest.error),
    )
  }
  return parsedDigest.data
}

/**
 * Validates and deterministically orders a canonical capsule artifact manifest.
 *
 * Collection order, filesystem enumeration order, and locale settings cannot
 * affect the normalized representation.
 */
export function normalizeCapsuleArtifactManifest(value: unknown): CapsuleArtifactManifest {
  const parsed = CapsuleArtifactManifestSchema.safeParse(value)
  if (!parsed.success) {
    throw new GlobalError(
      'Capsule artifact manifest failed validation.',
      GlobalErrorCode.BAD_REQUEST,
      validationDetails(parsed.error),
    )
  }
  const normalized = {
    schemaVersion: parsed.data.schemaVersion,
    roots: [...parsed.data.roots].sort(compareManifestRoots),
    entries: [...parsed.data.entries].sort(compareManifestEntries),
  }
  const validated = CapsuleArtifactManifestSchema.safeParse(normalized)
  if (!validated.success) {
    throw new GlobalError(
      'Normalized capsule artifact manifest failed validation.',
      GlobalErrorCode.INTERNAL_ERROR,
      validationDetails(validated.error),
    )
  }
  return validated.data
}

/**
 * Produces the immutable digest of a validated, deterministically ordered
 * capsule artifact manifest.
 */
export function digestCapsuleArtifactManifest(value: unknown): CapsuleArtifactManifestDigest {
  return digestNormalizedCapsuleArtifactManifest(normalizeCapsuleArtifactManifest(value))
}

/**
 * Creates the immutable public reference for a validated artifact manifest.
 *
 * The reference alone does not claim that provider snapshots or a committed
 * capsule snapshot exist.
 */
export function createCapsuleArtifactManifestReference(value: unknown): CapsuleArtifactManifestReference {
  const manifest = normalizeCapsuleArtifactManifest(value)
  const reference = {
    schemaVersion: manifest.schemaVersion,
    digest: digestNormalizedCapsuleArtifactManifest(manifest),
  }
  const parsedReference = CapsuleArtifactManifestReferenceSchema.safeParse(reference)
  if (!parsedReference.success) {
    throw new GlobalError(
      'Generated capsule artifact manifest reference failed validation.',
      GlobalErrorCode.INTERNAL_ERROR,
      validationDetails(parsedReference.error),
    )
  }
  return parsedReference.data
}
