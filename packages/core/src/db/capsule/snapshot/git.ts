import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type PgColumn,
} from 'drizzle-orm/pg-core'
import {
  CapsuleSnapshotGitRemoteTransportValues,
  type CapsuleArtifactLogicalPath,
  type CapsuleBlueprintIdentifier,
  type CapsuleSnapshotGitObjectId,
  type CapsuleSnapshotGitReference,
} from '../../../schemas'

export const capsuleSnapshotGitRemoteTransportEnum = pgEnum(
  'capsule_snapshot_git_remote_transport',
  CapsuleSnapshotGitRemoteTransportValues,
)

function createSnapshotIdColumn(snapshotIdColumn?: PgColumn) {
  return snapshotIdColumn
    ? uuid('snapshot_id')
        .notNull()
        .references(() => snapshotIdColumn, { onDelete: 'cascade' })
    : uuid('snapshot_id').notNull()
}

function createManifestRootIdColumn(manifestRootIdColumn?: PgColumn) {
  return manifestRootIdColumn
    ? uuid('manifest_root_id')
        .notNull()
        .references(() => manifestRootIdColumn, { onDelete: 'cascade' })
    : uuid('manifest_root_id').notNull()
}

function createRepositoryIdColumn(repositoryIdColumn?: PgColumn) {
  return repositoryIdColumn
    ? uuid('repository_id')
        .notNull()
        .references(() => repositoryIdColumn, { onDelete: 'cascade' })
    : uuid('repository_id').notNull()
}

/**
 * Creates semantic Git evidence for repositories declared by the historical
 * capture policy.
 *
 * Administrative `.git` content remains outside the canonical artifact tree.
 * The future capture transaction must prove that each row corresponds to a
 * declared repository in the persisted policy pin.
 */
export function createCapsuleSnapshotGitRepositoriesTable(
  snapshotIdColumn?: PgColumn,
  manifestRootIdColumn?: PgColumn,
) {
  const snapshotId = createSnapshotIdColumn(snapshotIdColumn)
  const manifestRootId = createManifestRootIdColumn(manifestRootIdColumn)

  return pgTable(
    'capsule_snapshot_git_repositories',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      snapshotId,
      manifestRootId,
      repositoryId: text('repository_id').$type<CapsuleBlueprintIdentifier>().notNull(),
      path: text('path').notNull(),
      logicalPath: text('logical_path').$type<CapsuleArtifactLogicalPath>().notNull(),
      headCommit: text('head_commit').$type<CapsuleSnapshotGitObjectId>(),
      headReference: text('head_reference').$type<CapsuleSnapshotGitReference>(),
      detached: boolean('detached').notNull(),
      indexDirty: boolean('index_dirty').notNull(),
      worktreeDirty: boolean('worktree_dirty').notNull(),
      untracked: boolean('untracked').notNull(),
    },
    table => [
      index('capsule_snapshot_git_repositories_snapshot_idx').on(table.snapshotId),
      index('capsule_snapshot_git_repositories_root_idx').on(table.manifestRootId),
      uniqueIndex('capsule_snapshot_git_repositories_snapshot_id_unique_idx').on(table.snapshotId, table.repositoryId),
      uniqueIndex('capsule_snapshot_git_repositories_snapshot_location_unique_idx').on(
        table.snapshotId,
        table.manifestRootId,
        table.path,
      ),
      check(
        'capsule_snapshot_git_repositories_head_check',
        sql`(
          (
            ${table.detached} = true
            AND ${table.headCommit} IS NOT NULL
            AND ${table.headReference} IS NULL
          )
          OR
          (
            ${table.detached} = false
            AND ${table.headReference} IS NOT NULL
          )
        )`,
      ),
      check(
        'capsule_snapshot_git_repositories_commit_check',
        sql`(
          ${table.headCommit} IS NULL
          OR ${table.headCommit} ~ '^(?:[a-f0-9]{40}|[a-f0-9]{64})$'
        )`,
      ),
    ],
  )
}

/**
 * Creates structured, credential-free Git remote metadata.
 *
 * Arbitrary remote URLs are intentionally absent. The schema has no field for
 * usernames, passwords, query strings, fragments, or embedded access tokens.
 */
export function createCapsuleSnapshotGitRemotesTable(repositoryIdColumn?: PgColumn) {
  const repositoryId = createRepositoryIdColumn(repositoryIdColumn)
  return pgTable(
    'capsule_snapshot_git_remotes',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      repositoryId,
      name: text('name').$type<CapsuleBlueprintIdentifier>().notNull(),
      transport: capsuleSnapshotGitRemoteTransportEnum('transport').notNull(),
      host: text('host').notNull(),
      port: integer('port'),
      repositoryPath: text('repository_path').notNull(),
    },
    table => [
      index('capsule_snapshot_git_remotes_repository_idx').on(table.repositoryId),
      uniqueIndex('capsule_snapshot_git_remotes_repository_name_unique_idx').on(table.repositoryId, table.name),
      check(
        'capsule_snapshot_git_remotes_port_check',
        sql`${table.port} IS NULL OR (${table.port} >= 1 AND ${table.port} <= 65535)`,
      ),
      check(
        'capsule_snapshot_git_remotes_host_check',
        sql`(
          ${table.host} <> ''
          AND ${table.host} = lower(${table.host})
          AND ${table.host} !~ '[@/?#]'
        )`,
      ),
      check(
        'capsule_snapshot_git_remotes_path_check',
        sql`${table.repositoryPath} LIKE '/%' AND ${table.repositoryPath} !~ '[?#]'`,
      ),
    ],
  )
}
