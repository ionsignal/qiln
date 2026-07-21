import { z } from 'zod'
import { containsPosixPathSegment, isCanonicalAbsolutePosixPath } from '../../posix'

const GIT_ADMINISTRATIVE_PATH_SEGMENT = '.git'

/**
 * Stable identifiers associating artifact entries with one managed root.
 *
 * Root IDs originate in the pinned blueprint capture policy. They are logical
 * capsule identifiers rather than provider volume names or host paths.
 */
export const CapsuleArtifactRootIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(
    /^[a-zA-Z0-9](?:[a-zA-Z0-9_-]{0,98}[a-zA-Z0-9])?$/,
    'Capsule artifact root IDs must be alphanumeric and may contain internal hyphens or underscores.',
  )

/**
 * Canonical absolute POSIX path used by artifact manifests.
 *
 * Logical paths are independent of host filesystem paths. Git administrative
 * paths are represented by repository records, not ordinary artifact roots or
 * entries.
 */
export const CapsuleArtifactLogicalPathSchema = z
  .string()
  .refine(isCanonicalAbsolutePosixPath, {
    message: 'Capsule artifact logical paths must be canonical absolute POSIX paths.',
  })
  .refine(value => !containsPosixPathSegment(value, GIT_ADMINISTRATIVE_PATH_SEGMENT), {
    message: "Capsule artifact logical paths cannot include a '.git' administrative path.",
  })

export const CapsuleArtifactContentDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/, {
  message: "Capsule artifact content digests must use the format 'sha256:<64 lowercase hex characters>'.",
})

export const CapsuleArtifactEntryType = {
  FILE: 'file',
  DIRECTORY: 'directory',
} as const

export type CapsuleArtifactEntryTypeValue = (typeof CapsuleArtifactEntryType)[keyof typeof CapsuleArtifactEntryType]

export const CapsuleArtifactEntryTypeValues = [CapsuleArtifactEntryType.FILE, CapsuleArtifactEntryType.DIRECTORY] as const

export const CapsuleArtifactEntryTypeSchema = z.enum(CapsuleArtifactEntryTypeValues)

const CapsuleArtifactModeSchema = z.string().regex(/^[0-7]{4}$/, {
  message: 'Capsule artifact modes must contain exactly four octal digits.',
})

const CAPSULE_ARTIFACT_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * Canonical artifact timestamp used as digest input.
 *
 * Offset-equivalent and variable-precision strings are rejected rather than
 * silently normalized.
 */
export const CapsuleArtifactTimestampSchema = z
  .string()
  .regex(CAPSULE_ARTIFACT_TIMESTAMP_PATTERN, {
    message: "Capsule artifact timestamps must use canonical UTC millisecond form 'YYYY-MM-DDTHH:mm:ss.sssZ'.",
  })
  .refine(isCanonicalArtifactTimestamp, {
    message: 'Capsule artifact timestamps must represent a valid canonical UTC instant.',
  })

export type CapsuleArtifactTimestamp = z.infer<typeof CapsuleArtifactTimestampSchema>

/**
 * Formats a trusted Date where an artifact timestamp is constructed.
 *
 * Unknown strings must be validated directly instead of parsed and rewritten.
 */
export function toCanonicalCapsuleArtifactTimestamp(value: Date): CapsuleArtifactTimestamp {
  if (!(value instanceof Date)) {
    throw new TypeError('Capsule artifact timestamps must be constructed from a Date.')
  }
  if (!Number.isFinite(value.getTime())) {
    throw new RangeError('Cannot construct a capsule artifact timestamp from an invalid Date.')
  }
  return CapsuleArtifactTimestampSchema.parse(value.toISOString())
}

const CapsuleArtifactEntryBaseSchema = z.object({
  rootId: CapsuleArtifactRootIdSchema,
  logicalPath: CapsuleArtifactLogicalPathSchema,
  mode: CapsuleArtifactModeSchema,
  uid: z.number().int().nonnegative(),
  gid: z.number().int().nonnegative(),
  modifiedAt: CapsuleArtifactTimestampSchema,
})

/**
 * Canonical regular-file identity.
 *
 * File bytes remain in physical snapshot storage or a future content-addressed
 * artifact store.
 */
export const CapsuleArtifactFileEntrySchema = CapsuleArtifactEntryBaseSchema.extend({
  type: z.literal(CapsuleArtifactEntryType.FILE),
  size: z.number().int().nonnegative(),
  contentDigest: CapsuleArtifactContentDigestSchema,
}).strict()

/**
 * Canonical directory identity.
 *
 * Directories are explicit so empty directories and restoration metadata remain
 * representable.
 */
export const CapsuleArtifactDirectoryEntrySchema = CapsuleArtifactEntryBaseSchema.extend({
  type: z.literal(CapsuleArtifactEntryType.DIRECTORY),
}).strict()

export const CapsuleArtifactEntrySchema = z.discriminatedUnion('type', [CapsuleArtifactFileEntrySchema, CapsuleArtifactDirectoryEntrySchema])

export type CapsuleArtifactRootId = z.infer<typeof CapsuleArtifactRootIdSchema>
export type CapsuleArtifactLogicalPath = z.infer<typeof CapsuleArtifactLogicalPathSchema>
export type CapsuleArtifactContentDigest = z.infer<typeof CapsuleArtifactContentDigestSchema>
export type CapsuleArtifactFileEntry = z.infer<typeof CapsuleArtifactFileEntrySchema>
export type CapsuleArtifactDirectoryEntry = z.infer<typeof CapsuleArtifactDirectoryEntrySchema>
export type CapsuleArtifactEntry = z.infer<typeof CapsuleArtifactEntrySchema>

function isCanonicalArtifactTimestamp(value: string): boolean {
  const timestamp = new Date(value)
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value
}
