import { z } from 'zod'
import { absolutePosixParentPath, isAbsolutePosixPathAtOrBelow } from '../../posix'
import { CapsuleArtifactEntrySchema, CapsuleArtifactEntryType, CapsuleArtifactLogicalPathSchema, CapsuleArtifactRootIdSchema } from './entry'

export const CAPSULE_ARTIFACT_MANIFEST_SCHEMA_VERSION = 1 as const

export const CapsuleArtifactManifestSchemaVersionSchema = z.literal(CAPSULE_ARTIFACT_MANIFEST_SCHEMA_VERSION)

export const CapsuleArtifactManifestRootSchema = z
  .object({
    id: CapsuleArtifactRootIdSchema,
    logicalPath: CapsuleArtifactLogicalPathSchema,
  })
  .strict()

/**
 * Canonical V1 filesystem representation of one committed capsule snapshot.
 *
 * Represented semantics:
 *
 * - regular files;
 * - directories, including empty directories;
 * - canonical logical paths;
 * - POSIX mode;
 * - UID and GID;
 * - canonical modified time;
 * - regular-file byte size;
 * - regular-file content digest.
 *
 * Deliberately unsupported semantics:
 *
 * - symlinks;
 * - devices, sockets, and FIFOs;
 * - ACLs and extended attributes;
 * - hard-link topology;
 * - sparse extents;
 * - provider filesystem implementation details.
 *
 * Physical provider snapshots may preserve additional filesystem state, but the
 * canonical manifest does not claim semantics it does not model. A V1 collector
 * must use `lstat`, must not follow unsupported entries, and must fail closed
 * if one is encountered beneath a traversed managed root.
 *
 * Every root has an explicit directory entry and every nested entry has a
 * directory parent in the same root. This mechanically represents empty
 * directories and rejects incomplete collection trees.
 */
export const CapsuleArtifactManifestSchema = z
  .object({
    schemaVersion: CapsuleArtifactManifestSchemaVersionSchema,
    roots: z.array(CapsuleArtifactManifestRootSchema).min(1),
    entries: z.array(CapsuleArtifactEntrySchema).min(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    const rootsById = new Map<string, (typeof manifest.roots)[number]>()
    const rootPathIndexes = new Map<string, number>()
    manifest.roots.forEach((root, index) => {
      if (rootsById.has(root.id)) {
        context.addIssue({
          code: 'custom',
          path: ['roots', index, 'id'],
          message: `Duplicate capsule artifact root ID '${root.id}'.`,
        })
      } else {
        rootsById.set(root.id, root)
      }
      const existingPathIndex = rootPathIndexes.get(root.logicalPath)
      if (existingPathIndex !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['roots', index, 'logicalPath'],
          message: `Capsule artifact root path '${root.logicalPath}' is already used by root at index ${existingPathIndex}.`,
        })
      } else {
        rootPathIndexes.set(root.logicalPath, index)
      }
    })

    for (let leftIndex = 0; leftIndex < manifest.roots.length; leftIndex++) {
      const left = manifest.roots[leftIndex]!
      for (let rightIndex = leftIndex + 1; rightIndex < manifest.roots.length; rightIndex++) {
        const right = manifest.roots[rightIndex]!
        if (
          isAbsolutePosixPathAtOrBelow(left.logicalPath, right.logicalPath) ||
          isAbsolutePosixPathAtOrBelow(right.logicalPath, left.logicalPath)
        ) {
          context.addIssue({
            code: 'custom',
            path: ['roots', rightIndex, 'logicalPath'],
            message: `Capsule artifact roots '${left.id}' and '${right.id}' overlap.`,
          })
        }
      }
    }

    const entriesByIdentity = new Map<string, (typeof manifest.entries)[number]>()
    manifest.entries.forEach((entry, index) => {
      const root = rootsById.get(entry.rootId)
      if (!root) {
        context.addIssue({
          code: 'custom',
          path: ['entries', index, 'rootId'],
          message: `Capsule artifact entry references unknown root '${entry.rootId}'.`,
        })
        return
      }
      if (!isAbsolutePosixPathAtOrBelow(entry.logicalPath, root.logicalPath)) {
        context.addIssue({
          code: 'custom',
          path: ['entries', index, 'logicalPath'],
          message: `Capsule artifact entry path '${entry.logicalPath}' is outside root '${root.id}'.`,
        })
      }
      const identity = artifactEntryIdentity(entry.rootId, entry.logicalPath)
      if (entriesByIdentity.has(identity)) {
        context.addIssue({
          code: 'custom',
          path: ['entries', index, 'logicalPath'],
          message: `Duplicate capsule artifact entry '${entry.rootId}:${entry.logicalPath}'.`,
        })
      } else {
        entriesByIdentity.set(identity, entry)
      }
    })

    manifest.roots.forEach((root, rootIndex) => {
      const rootEntry = entriesByIdentity.get(artifactEntryIdentity(root.id, root.logicalPath))
      if (!rootEntry) {
        context.addIssue({
          code: 'custom',
          path: ['roots', rootIndex, 'logicalPath'],
          message: `Capsule artifact root '${root.id}' has no directory entry.`,
        })
        return
      }
      if (rootEntry.type !== CapsuleArtifactEntryType.DIRECTORY) {
        context.addIssue({
          code: 'custom',
          path: ['roots', rootIndex, 'logicalPath'],
          message: `Capsule artifact root '${root.id}' must resolve to a directory entry.`,
        })
      }
    })

    manifest.entries.forEach((entry, index) => {
      const root = rootsById.get(entry.rootId)
      if (!root || entry.logicalPath === root.logicalPath || !isAbsolutePosixPathAtOrBelow(entry.logicalPath, root.logicalPath)) {
        return
      }
      const parentPath = absolutePosixParentPath(entry.logicalPath)
      const parent = entriesByIdentity.get(artifactEntryIdentity(entry.rootId, parentPath))
      if (!parent) {
        context.addIssue({
          code: 'custom',
          path: ['entries', index, 'logicalPath'],
          message: `Capsule artifact entry '${entry.logicalPath}' has no manifest parent '${parentPath}'.`,
        })
        return
      }
      if (parent.type !== CapsuleArtifactEntryType.DIRECTORY) {
        context.addIssue({
          code: 'custom',
          path: ['entries', index, 'logicalPath'],
          message: `Capsule artifact entry parent '${parentPath}' is not a directory.`,
        })
      }
    })
  })

export type CapsuleArtifactManifestSchemaVersion = z.infer<typeof CapsuleArtifactManifestSchemaVersionSchema>
export type CapsuleArtifactManifestRoot = z.infer<typeof CapsuleArtifactManifestRootSchema>
export type CapsuleArtifactManifest = z.infer<typeof CapsuleArtifactManifestSchema>

function artifactEntryIdentity(rootId: string, logicalPath: string): string {
  return `${rootId}\u0000${logicalPath}`
}
