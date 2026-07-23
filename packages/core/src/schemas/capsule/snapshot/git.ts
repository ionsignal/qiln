import { z } from 'zod'
import { CapsuleBlueprintIdentifierSchema } from '../../blueprint/provision'
import { isCanonicalAbsolutePosixPath, isCanonicalRelativePosixPath } from '../../posix'
import { CapsuleArtifactLogicalPathSchema, CapsuleArtifactRootIdSchema } from '../artifact/entry'

const GIT_REFERENCE_FORBIDDEN_CHARACTER_PATTERN = /[\u0000-\u0020\u007f~^:?*[\\]/
const GIT_REMOTE_HOST_PATTERN =
  /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*$/

function isSupportedGitReference(value: string): boolean {
  if (!value.startsWith('refs/') || value.endsWith('/') || value.endsWith('.')) {
    return false
  }
  if (GIT_REFERENCE_FORBIDDEN_CHARACTER_PATTERN.test(value)) {
    return false
  }
  if (value.includes('..') || value.includes('@{')) {
    return false
  }
  const components = value.split('/')
  if (components.length < 2 || components[0] !== 'refs') {
    return false
  }
  return components.every(component => component !== '' && !component.startsWith('.') && !component.endsWith('.lock'))
}

export const CapsuleSnapshotGitObjectIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, {
  message: 'Snapshot Git object IDs must be lowercase SHA-1 or SHA-256 hexadecimal values.',
})

/**
 * Supported full Git reference persisted as committed snapshot evidence.
 *
 * The contract intentionally accepts only a narrow, credential-free,
 * implementation-independent subset of `git check-ref-format` references.
 * Values are validated exactly as supplied and are never trimmed or rewritten.
 */
export const CapsuleSnapshotGitReferenceSchema = z.string().min(1).max(1024).refine(isSupportedGitReference, {
  message:
    "Snapshot Git references must be supported full refs beginning with 'refs/' and cannot contain forbidden Git ref characters or components.",
})

export const CapsuleSnapshotGitRemoteTransport = {
  HTTPS: 'https',
  SSH: 'ssh',
} as const

export type CapsuleSnapshotGitRemoteTransport =
  (typeof CapsuleSnapshotGitRemoteTransport)[keyof typeof CapsuleSnapshotGitRemoteTransport]

export const CapsuleSnapshotGitRemoteTransportValues = [
  CapsuleSnapshotGitRemoteTransport.HTTPS,
  CapsuleSnapshotGitRemoteTransport.SSH,
] as const

export const CapsuleSnapshotGitRemoteTransportSchema = z.enum(CapsuleSnapshotGitRemoteTransportValues)

/**
 * Credential-free Git remote metadata.
 *
 * Remote URLs are intentionally not persisted. Separating transport, host,
 * port, and repository path leaves no field for usernames, passwords, query
 * strings, fragments, or embedded access tokens.
 */
export const CapsuleSnapshotGitRemoteSchema = z
  .object({
    name: CapsuleBlueprintIdentifierSchema,
    transport: CapsuleSnapshotGitRemoteTransportSchema,
    host: z.string().trim().toLowerCase().regex(GIT_REMOTE_HOST_PATTERN, {
      message: 'Snapshot Git remote hosts must be credential-free DNS host names.',
    }),
    port: z.number().int().min(1).max(65535).nullable(),
    repositoryPath: z.string().refine(isCanonicalAbsolutePosixPath, {
      message: 'Snapshot Git remote repository paths must be canonical absolute POSIX paths.',
    }),
  })
  .strict()

/**
 * Semantic Git evidence for one repository declared by the pinned policy.
 *
 * Git administrative files do not become artifact entries. The canonical
 * working tree remains represented by the artifact manifest, while this record
 * preserves only supported repository semantics.
 *
 * Detached HEAD requires a concrete commit and cannot have a symbolic
 * reference. A symbolic HEAD always has a full reference; its commit may be
 * null only for an unborn symbolic branch.
 */
export const CapsuleSnapshotGitRepositorySchema = z
  .object({
    repositoryId: CapsuleBlueprintIdentifierSchema,
    artifactRootId: CapsuleArtifactRootIdSchema,
    path: z.string().refine(value => isCanonicalRelativePosixPath(value, true), {
      message: "Snapshot Git repository paths must be canonical relative POSIX paths; use '.' for the root.",
    }),
    logicalPath: CapsuleArtifactLogicalPathSchema,
    headCommit: CapsuleSnapshotGitObjectIdSchema.nullable(),
    headReference: CapsuleSnapshotGitReferenceSchema.nullable(),
    detached: z.boolean(),
    indexDirty: z.boolean(),
    worktreeDirty: z.boolean(),
    untracked: z.boolean(),
    remotes: z.array(CapsuleSnapshotGitRemoteSchema),
  })
  .strict()
  .superRefine((repository, context) => {
    if (repository.detached && repository.headReference !== null) {
      context.addIssue({
        code: 'custom',
        path: ['headReference'],
        message: 'A detached Snapshot Git HEAD cannot have a symbolic reference.',
      })
    }
    if (repository.detached && repository.headCommit === null) {
      context.addIssue({
        code: 'custom',
        path: ['headCommit'],
        message: 'A detached Snapshot Git HEAD must identify a commit.',
      })
    }
    if (!repository.detached && repository.headReference === null) {
      context.addIssue({
        code: 'custom',
        path: ['headReference'],
        message: 'A non-detached Snapshot Git HEAD must have a symbolic reference.',
      })
    }
    const remoteNames = new Set<string>()
    repository.remotes.forEach((remote, index) => {
      if (remoteNames.has(remote.name)) {
        context.addIssue({
          code: 'custom',
          path: ['remotes', index, 'name'],
          message: `Duplicate Snapshot Git remote name '${remote.name}'.`,
        })
      } else {
        remoteNames.add(remote.name)
      }
    })
  })

export type CapsuleSnapshotGitObjectId = z.infer<typeof CapsuleSnapshotGitObjectIdSchema>
export type CapsuleSnapshotGitReference = z.infer<typeof CapsuleSnapshotGitReferenceSchema>
export type CapsuleSnapshotGitRemote = z.infer<typeof CapsuleSnapshotGitRemoteSchema>
export type CapsuleSnapshotGitRepository = z.infer<typeof CapsuleSnapshotGitRepositorySchema>
