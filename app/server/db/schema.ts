import { sql, defineRelations } from 'drizzle-orm'
import { boolean, check, index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import {
  capsuleActorTypeEnum,
  capsuleArtifactEntryTypeEnum,
  capsuleBranchResourceCleanupPolicyEnum,
  capsuleBranchResourceStatusEnum,
  capsuleBranchResourceTypeEnum,
  capsuleBranchPreviewStatusEnum,
  capsuleBranchStatusEnum,
  capsuleLifecycleStatusEnum,
  capsuleOperationStatusEnum,
  capsuleOperationStepStatusEnum,
  capsuleOperationTypeEnum,
  capsuleRouteAliasStatusEnum,
  capsuleRouteExposureEnum,
  capsuleRouteMethodEnum,
  capsuleRouteProviderEnum,
  capsuleRouteProviderStatusEnum,
  capsuleRouteRevisionActionEnum,
  capsuleRouteRevisionStatusEnum,
  CapsuleSnapshotAgentArtifactContentPolicyEnum,
  capsuleSnapshotCaptureResourceStatusEnum,
  capsuleSnapshotDependencyDigestKindEnum,
  capsuleSnapshotDependencyKindEnum,
  capsuleSnapshotGitRemoteTransportEnum,
  capsuleSnapshotModeEnum,
  capsuleSnapshotResourceKindEnum,
  capsuleSnapshotResourceProviderEnum,
  createCapsuleSchema,
  defineCapsuleRelations,
  mergeRelationFragments,
  SshBranchAccessBlockReasonValues,
  SshBranchAccessStateValues,
  SshBranchGrantStatusValues,
  SshPublicKeyAlgorithmValues,
  SshPublicKeyStatusValues,
  SshRelayStatusValues,
  SshTicketStatusValues,
} from '@qiln/core/server'

export const users = pgTable('users', {
  id: uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`),
  username: text('username').notNull().unique(),
  email: text('email').notNull().unique(),
  password: text('password').notNull(),
  avatar: text('avatar').notNull().default('default'),
  isAdmin: boolean('is_admin').notNull().default(false),
  createdAt: timestamp('created_at', {
    withTimezone: true,
    mode: 'date',
  })
    .notNull()
    .defaultNow(),
})

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', {
    withTimezone: true,
    mode: 'date',
  }).notNull(),
})

export const capsuleTables = createCapsuleSchema(users.id)

/**
 * Host-owned API credentials bind one external agent actor and requester to an
 * optional capsule scope. The key secret is never persisted in plaintext.
 */
export const agentCredentials = pgTable(
  'agent_credentials',
  {
    id: uuid('id').primaryKey(),
    keyHash: text('key_hash').notNull(),
    agentActorId: uuid('agent_actor_id').notNull(),
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    capsuleId: uuid('capsule_id').references(() => capsuleTables.capsules.id, {
      onDelete: 'restrict',
    }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date',
    })
      .notNull()
      .defaultNow(),
  },
  table => [
    index('agent_credentials_requested_by_user_idx').on(table.requestedByUserId),
    index('agent_credentials_capsule_idx').on(table.capsuleId),
    index('agent_credentials_active_idx').on(table.isActive),
  ],
)

export const sshPublicKeyAlgorithmEnum = pgEnum('ssh_public_key_algorithm', SshPublicKeyAlgorithmValues)
export const sshPublicKeyStatusEnum = pgEnum('ssh_public_key_status', SshPublicKeyStatusValues)
export const sshBranchAccessStateEnum = pgEnum('ssh_branch_access_state', SshBranchAccessStateValues)
export const sshBranchAccessBlockReasonEnum = pgEnum('ssh_branch_access_block_reason', SshBranchAccessBlockReasonValues)
export const sshBranchGrantStatusEnum = pgEnum('ssh_branch_grant_status', SshBranchGrantStatusValues)
export const sshTicketStatusEnum = pgEnum('ssh_ticket_status', SshTicketStatusValues)
export const sshRelayStatusEnum = pgEnum('ssh_relay_status', SshRelayStatusValues)

/**
 * Host-owned canonical SSH public-key registrations.
 *
 * The complete canonical public-key blob is the durable identity and is unique.
 * The OpenSSH SHA-256 fingerprint is indexed for lookup and display, but is not
 * sufficient authorization without an exact canonical algorithm and blob
 * comparison.
 */
export const sshPublicKeys = pgTable(
  'ssh_public_keys',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    algorithm: sshPublicKeyAlgorithmEnum('algorithm').notNull(),
    publicKeyBlob: text('public_key_blob').notNull(),
    fingerprint: text('fingerprint').notNull(),
    label: text('label'),
    status: sshPublicKeyStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date',
      precision: 3,
    })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp('revoked_at', {
      withTimezone: true,
      mode: 'date',
      precision: 3,
    }),
  },
  table => [
    uniqueIndex('ssh_public_keys_blob_unique_idx').on(table.publicKeyBlob),
    index('ssh_public_keys_owner_status_idx').on(table.ownerUserId, table.status),
    index('ssh_public_keys_fingerprint_idx').on(table.fingerprint),
    check(
      'ssh_public_keys_state_check',
      sql`(
        (
          ${table.status} = 'active'
          AND ${table.revokedAt} IS NULL
        )
        OR
        (
          ${table.status} = 'revoked'
          AND ${table.revokedAt} IS NOT NULL
        )
      )`,
    ),
    check('ssh_public_keys_fingerprint_check', sql`${table.fingerprint} ~ '^SHA256:[A-Za-z0-9+/]{43}$'`),
    check('ssh_public_keys_blob_check', sql`length(${table.publicKeyBlob}) BETWEEN 1 AND 16384`),
    check(
      'ssh_public_keys_label_check',
      sql`(
        ${table.label} IS NULL
        OR (
          length(btrim(${table.label})) BETWEEN 1 AND 128
          AND ${table.label} = btrim(${table.label})
          AND ${table.label} !~ '[[:cntrl:]]'
        )
      )`,
    ),
  ],
)

/**
 * Host-owned per-branch SSH access fence.
 *
 * Newly created and forked branches must receive one explicit blocked row.
 * Enablement may update an existing blocked row only; Host policy must never
 * silently create an enabled fence.
 *
 * Branch ownership and capsule identity remain authoritative through the branch
 * relation rather than denormalized access-row columns.
 */
export const sshBranchAccess = pgTable(
  'ssh_branch_access',
  {
    branchId: uuid('branch_id')
      .primaryKey()
      .references(() => capsuleTables.capsuleBranches.id, {
        onDelete: 'restrict',
      }),
    state: sshBranchAccessStateEnum('state').notNull().default('blocked'),
    blockReason: sshBranchAccessBlockReasonEnum('block_reason'),
    enabledAt: timestamp('enabled_at', {
      withTimezone: true,
      mode: 'date',
      precision: 3,
    }),
    blockedAt: timestamp('blocked_at', {
      withTimezone: true,
      mode: 'date',
      precision: 3,
    }),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date',
      precision: 3,
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'date',
      precision: 3,
    })
      .notNull()
      .defaultNow(),
  },
  table => [
    index('ssh_branch_access_state_idx').on(table.state),
    check(
      'ssh_branch_access_state_check',
      sql`(
        (
          ${table.state} = 'enabled'
          AND ${table.blockReason} IS NULL
          AND ${table.enabledAt} IS NOT NULL
        )
        OR
        (
          ${table.state} = 'blocked'
          AND ${table.blockReason} IS NOT NULL
          AND ${table.blockedAt} IS NOT NULL
        )
      )`,
    ),
    check(
      'ssh_branch_access_timestamp_check',
      sql`(
        ${table.enabledAt} IS NULL
        OR ${table.enabledAt} >= ${table.createdAt}
      )
      AND
      (
        ${table.blockedAt} IS NULL
        OR ${table.blockedAt} >= ${table.createdAt}
      )`,
    ),
  ],
)

/**
 * Admin-created binding between one registered SSH key and one editable branch.
 *
 * Key-owner, capsule-owner, capsule, and binding-admin columns are immutable
 * audit evidence. Host policy must transactionally prove that they still agree
 * with the current key and branch relations before ticket issue or redemption.
 */
export const sshBranchGrants = pgTable(
  'ssh_branch_grants',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    publicKeyId: uuid('public_key_id')
      .notNull()
      .references(() => sshPublicKeys.id, { onDelete: 'restrict' }),
    keyOwnerUserId: uuid('key_owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    capsuleOwnerUserId: uuid('capsule_owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    capsuleId: uuid('capsule_id')
      .notNull()
      .references(() => capsuleTables.capsules.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => capsuleTables.capsuleBranches.id, {
        onDelete: 'restrict',
      }),
    boundByAdminUserId: uuid('bound_by_admin_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    status: sshBranchGrantStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date',
      precision: 3,
    })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp('revoked_at', {
      withTimezone: true,
      mode: 'date',
      precision: 3,
    }),
  },
  table => [
    index('ssh_branch_grants_key_owner_idx').on(table.keyOwnerUserId),
    index('ssh_branch_grants_capsule_owner_idx').on(table.capsuleOwnerUserId),
    index('ssh_branch_grants_capsule_idx').on(table.capsuleId),
    index('ssh_branch_grants_branch_idx').on(table.branchId),
    index('ssh_branch_grants_admin_idx').on(table.boundByAdminUserId),
    index('ssh_branch_grants_status_idx').on(table.status),
    uniqueIndex('ssh_branch_grants_active_key_unique_idx')
      .on(table.publicKeyId)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex('ssh_branch_grants_active_key_branch_unique_idx')
      .on(table.publicKeyId, table.branchId)
      .where(sql`${table.status} = 'active'`),
    check(
      'ssh_branch_grants_state_check',
      sql`(
        (
          ${table.status} = 'active'
          AND ${table.revokedAt} IS NULL
          AND ${table.revokedByUserId} IS NULL
        )
        OR
        (
          ${table.status} = 'revoked'
          AND ${table.revokedAt} IS NOT NULL
        )
      )`,
    ),
    check(
      'ssh_branch_grants_timestamp_check',
      sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt}`,
    ),
  ],
)

/**
 * Short-lived, single-use SSH gateway tickets.
 *
 * Only a SHA-256 hash of the opaque bearer ticket is persisted. Raw ticket
 * material, branch runtime destinations, private keys, and client-supplied
 * routing data have no persistence field.
 */
export const sshTickets = pgTable(
  'ssh_tickets',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    ticketHash: text('ticket_hash').notNull(),
    publicKeyId: uuid('public_key_id')
      .notNull()
      .references(() => sshPublicKeys.id, { onDelete: 'restrict' }),
    grantId: uuid('grant_id')
      .notNull()
      .references(() => sshBranchGrants.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    capsuleId: uuid('capsule_id')
      .notNull()
      .references(() => capsuleTables.capsules.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => capsuleTables.capsuleBranches.id, {
        onDelete: 'restrict',
      }),
    status: sshTicketStatusEnum('status').notNull().default('issued'),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
      precision: 3,
    }).notNull(),
    issuedAt: timestamp('issued_at', {
      withTimezone: true,
      mode: 'date',
      precision: 3,
    })
      .notNull()
      .defaultNow(),
    redeemedAt: timestamp('redeemed_at', {
      withTimezone: true,
      mode: 'date',
      precision: 3,
    }),
    revokedAt: timestamp('revoked_at', {
      withTimezone: true,
      mode: 'date',
      precision: 3,
    }),
  },
  table => [
    uniqueIndex('ssh_tickets_hash_unique_idx').on(table.ticketHash),
    index('ssh_tickets_key_idx').on(table.publicKeyId),
    index('ssh_tickets_grant_idx').on(table.grantId),
    index('ssh_tickets_user_idx').on(table.userId),
    index('ssh_tickets_capsule_idx').on(table.capsuleId),
    index('ssh_tickets_branch_status_idx').on(table.branchId, table.status),
    index('ssh_tickets_status_expiry_idx').on(table.status, table.expiresAt),
    check('ssh_tickets_hash_check', sql`${table.ticketHash} ~ '^sha256:[a-f0-9]{64}$'`),
    check('ssh_tickets_expiry_check', sql`${table.expiresAt} > ${table.issuedAt}`),
    check(
      'ssh_tickets_state_check',
      sql`(
        (
          ${table.status} = 'issued'
          AND ${table.redeemedAt} IS NULL
          AND ${table.revokedAt} IS NULL
        )
        OR
        (
          ${table.status} = 'redeemed'
          AND ${table.redeemedAt} IS NOT NULL
          AND ${table.revokedAt} IS NULL
        )
        OR
        (
          ${table.status} = 'revoked'
          AND ${table.revokedAt} IS NOT NULL
        )
      )`,
    ),
    check(
      'ssh_tickets_timestamp_check',
      sql`(
        ${table.redeemedAt} IS NULL
        OR ${table.redeemedAt} >= ${table.issuedAt}
      )
      AND
      (
        ${table.revokedAt} IS NULL
        OR ${table.revokedAt} >= ${table.issuedAt}
      )
      AND
      (
        ${table.redeemedAt} IS NULL
        OR ${table.revokedAt} IS NULL
        OR ${table.revokedAt} >= ${table.redeemedAt}
      )`,
    ),
  ],
)

/**
 * Durable SSH relay audit and revocation-coordination state.
 *
 * Relay rows deliberately contain no branch runtime IP or port. Ticket
 * redemption and activation must derive the current exact private destination
 * through Host policy. One redeemed ticket can create at most one relay.
 */
export const sshRelays = pgTable(
  'ssh_relays',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => sshTickets.id, { onDelete: 'restrict' }),
    publicKeyId: uuid('public_key_id')
      .notNull()
      .references(() => sshPublicKeys.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    capsuleId: uuid('capsule_id')
      .notNull()
      .references(() => capsuleTables.capsules.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => capsuleTables.capsuleBranches.id, {
        onDelete: 'restrict',
      }),
    gatewayInstanceId: text('gateway_instance_id').notNull(),
    status: sshRelayStatusEnum('status').notNull().default('opening'),
    openedAt: timestamp('opened_at', {
      withTimezone: true,
      mode: 'date',
      precision: 3,
    })
      .notNull()
      .defaultNow(),
    activatedAt: timestamp('activated_at', {
      withTimezone: true,
      mode: 'date',
      precision: 3,
    }),
    closingAt: timestamp('closing_at', {
      withTimezone: true,
      mode: 'date',
      precision: 3,
    }),
    closedAt: timestamp('closed_at', {
      withTimezone: true,
      mode: 'date',
      precision: 3,
    }),
    closureReason: text('closure_reason'),
  },
  table => [
    uniqueIndex('ssh_relays_ticket_unique_idx').on(table.ticketId),
    index('ssh_relays_key_idx').on(table.publicKeyId),
    index('ssh_relays_user_idx').on(table.userId),
    index('ssh_relays_capsule_idx').on(table.capsuleId),
    index('ssh_relays_branch_status_idx').on(table.branchId, table.status),
    index('ssh_relays_gateway_status_idx').on(table.gatewayInstanceId, table.status),
    check(
      'ssh_relays_gateway_instance_check',
      sql`(
        length(btrim(${table.gatewayInstanceId})) BETWEEN 1 AND 128
        AND ${table.gatewayInstanceId} = btrim(${table.gatewayInstanceId})
        AND ${table.gatewayInstanceId} !~ '[[:cntrl:]]'
      )`,
    ),
    check(
      'ssh_relays_closure_reason_check',
      sql`(
        ${table.closureReason} IS NULL
        OR (
          length(btrim(${table.closureReason})) BETWEEN 1 AND 128
          AND ${table.closureReason} = btrim(${table.closureReason})
          AND ${table.closureReason} !~ '[[:cntrl:]]'
        )
      )`,
    ),
    check(
      'ssh_relays_state_check',
      sql`(
        (
          ${table.status} = 'opening'
          AND ${table.activatedAt} IS NULL
          AND ${table.closingAt} IS NULL
          AND ${table.closedAt} IS NULL
          AND ${table.closureReason} IS NULL
        )
        OR
        (
          ${table.status} = 'active'
          AND ${table.activatedAt} IS NOT NULL
          AND ${table.closingAt} IS NULL
          AND ${table.closedAt} IS NULL
          AND ${table.closureReason} IS NULL
        )
        OR
        (
          ${table.status} = 'closing'
          AND ${table.closingAt} IS NOT NULL
          AND ${table.closedAt} IS NULL
          AND ${table.closureReason} IS NOT NULL
        )
        OR
        (
          ${table.status} = 'closed'
          AND ${table.closingAt} IS NOT NULL
          AND ${table.closedAt} IS NOT NULL
          AND ${table.closureReason} IS NOT NULL
        )
      )`,
    ),
    check(
      'ssh_relays_timestamp_check',
      sql`(
        ${table.activatedAt} IS NULL
        OR ${table.activatedAt} >= ${table.openedAt}
      )
      AND
      (
        ${table.closingAt} IS NULL
        OR ${table.closingAt} >= ${table.openedAt}
      )
      AND
      (
        ${table.closedAt} IS NULL
        OR (
          ${table.closingAt} IS NOT NULL
          AND ${table.closedAt} >= ${table.closingAt}
        )
      )`,
    ),
  ],
)

export {
  capsuleActorTypeEnum,
  capsuleArtifactEntryTypeEnum,
  capsuleBranchResourceCleanupPolicyEnum,
  capsuleBranchResourceStatusEnum,
  capsuleBranchResourceTypeEnum,
  capsuleBranchPreviewStatusEnum,
  capsuleBranchStatusEnum,
  capsuleLifecycleStatusEnum,
  capsuleOperationStatusEnum,
  capsuleOperationStepStatusEnum,
  capsuleOperationTypeEnum,
  capsuleRouteAliasStatusEnum,
  capsuleRouteExposureEnum,
  capsuleRouteMethodEnum,
  capsuleRouteProviderEnum,
  capsuleRouteProviderStatusEnum,
  capsuleRouteRevisionActionEnum,
  capsuleRouteRevisionStatusEnum,
  CapsuleSnapshotAgentArtifactContentPolicyEnum,
  capsuleSnapshotCaptureResourceStatusEnum,
  capsuleSnapshotDependencyDigestKindEnum,
  capsuleSnapshotDependencyKindEnum,
  capsuleSnapshotGitRemoteTransportEnum,
  capsuleSnapshotModeEnum,
  capsuleSnapshotResourceKindEnum,
  capsuleSnapshotResourceProviderEnum,
}

export const {
  capsules,
  capsuleBranches,
  capsuleOperations,
  capsuleCreateOperations,
  capsuleForkOperations,
  capsuleOperationSteps,
  capsuleBranchResources,
  capsuleBranchPreviews,
  capsuleSnapshots,
  capsuleArtifactManifests,
  capsuleArtifactManifestRoots,
  capsuleArtifactEntries,
  capsuleSnapshotGitRepositories,
  capsuleSnapshotGitRemotes,
  capsuleSnapshotDependencyReferences,
  capsuleSnapshotResourceReferences,
  capsuleSnapshotCaptureOperations,
  capsuleSnapshotCaptureResources,
  capsuleRouteAliases,
  capsuleRouteHeads,
  capsuleRouteRevisions,
  capsuleRouteOperations,
  capsuleRouteProviderApplications,
} = capsuleTables

/**
 * Unified physical schema consumed by Drizzle.
 */
export const schema = {
  users,
  sessions,
  agentCredentials,
  sshPublicKeyAlgorithmEnum,
  sshPublicKeyStatusEnum,
  sshBranchAccessStateEnum,
  sshBranchAccessBlockReasonEnum,
  sshBranchGrantStatusEnum,
  sshTicketStatusEnum,
  sshRelayStatusEnum,
  sshPublicKeys,
  sshBranchAccess,
  sshBranchGrants,
  sshTickets,
  sshRelays,
  capsuleActorTypeEnum,
  capsuleArtifactEntryTypeEnum,
  capsuleBranchStatusEnum,
  capsuleBranchPreviewStatusEnum,
  capsuleBranchResourceCleanupPolicyEnum,
  capsuleBranchResourceStatusEnum,
  capsuleBranchResourceTypeEnum,
  capsuleLifecycleStatusEnum,
  capsuleOperationStatusEnum,
  capsuleOperationStepStatusEnum,
  capsuleOperationTypeEnum,
  capsuleRouteAliasStatusEnum,
  capsuleRouteExposureEnum,
  capsuleRouteMethodEnum,
  capsuleRouteProviderEnum,
  capsuleRouteProviderStatusEnum,
  capsuleRouteRevisionActionEnum,
  capsuleRouteRevisionStatusEnum,
  CapsuleSnapshotAgentArtifactContentPolicyEnum,
  capsuleSnapshotCaptureResourceStatusEnum,
  capsuleSnapshotDependencyDigestKindEnum,
  capsuleSnapshotDependencyKindEnum,
  capsuleSnapshotGitRemoteTransportEnum,
  capsuleSnapshotModeEnum,
  capsuleSnapshotResourceKindEnum,
  capsuleSnapshotResourceProviderEnum,
  ...capsuleTables,
} as const

/**
 * Defines all host and capsule-domain relations using the Drizzle v1 relations
 * API. Duplicate relation names fail during fragment composition.
 */
export const relations = defineRelations(schema, helpers =>
  mergeRelationFragments(
    {
      users: {
        sessions: helpers.many.sessions(),
        capsules: helpers.many.capsules(),
        capsuleBranches: helpers.many.capsuleBranches(),
        capsuleOperations: helpers.many.capsuleOperations(),
        capsuleOperationSteps: helpers.many.capsuleOperationSteps(),
        capsuleBranchResources: helpers.many.capsuleBranchResources(),
        agentCredentials: helpers.many.agentCredentials(),
        sshPublicKeys: helpers.many.sshPublicKeys(),
        sshBranchGrantsAsKeyOwner: helpers.many.sshBranchGrants({
          from: helpers.users.id,
          to: helpers.sshBranchGrants.keyOwnerUserId,
        }),
        sshBranchGrantsAsCapsuleOwner: helpers.many.sshBranchGrants({
          from: helpers.users.id,
          to: helpers.sshBranchGrants.capsuleOwnerUserId,
        }),
        sshBranchGrantsBoundAsAdmin: helpers.many.sshBranchGrants({
          from: helpers.users.id,
          to: helpers.sshBranchGrants.boundByAdminUserId,
        }),
        sshBranchGrantsRevoked: helpers.many.sshBranchGrants({
          from: helpers.users.id,
          to: helpers.sshBranchGrants.revokedByUserId,
        }),
        sshTickets: helpers.many.sshTickets(),
        sshRelays: helpers.many.sshRelays(),
      },
      sessions: {
        user: helpers.one.users({
          from: helpers.sessions.userId,
          to: helpers.users.id,
        }),
      },
      capsules: {
        agentCredentials: helpers.many.agentCredentials(),
        sshBranchGrants: helpers.many.sshBranchGrants(),
        sshTickets: helpers.many.sshTickets(),
        sshRelays: helpers.many.sshRelays(),
      },
      capsuleBranches: {
        sshAccess: helpers.one.sshBranchAccess({
          from: helpers.capsuleBranches.id,
          to: helpers.sshBranchAccess.branchId,
          optional: true,
        }),
        sshGrants: helpers.many.sshBranchGrants(),
        sshTickets: helpers.many.sshTickets(),
        sshRelays: helpers.many.sshRelays(),
      },
      agentCredentials: {
        requester: helpers.one.users({
          from: helpers.agentCredentials.requestedByUserId,
          to: helpers.users.id,
          optional: false,
        }),
        capsule: helpers.one.capsules({
          from: helpers.agentCredentials.capsuleId,
          to: helpers.capsules.id,
        }),
      },
      sshPublicKeys: {
        owner: helpers.one.users({
          from: helpers.sshPublicKeys.ownerUserId,
          to: helpers.users.id,
          optional: false,
        }),
        grants: helpers.many.sshBranchGrants(),
        tickets: helpers.many.sshTickets(),
        relays: helpers.many.sshRelays(),
      },
      sshBranchAccess: {
        branch: helpers.one.capsuleBranches({
          from: helpers.sshBranchAccess.branchId,
          to: helpers.capsuleBranches.id,
          optional: false,
        }),
      },
      sshBranchGrants: {
        publicKey: helpers.one.sshPublicKeys({
          from: helpers.sshBranchGrants.publicKeyId,
          to: helpers.sshPublicKeys.id,
          optional: false,
        }),
        keyOwner: helpers.one.users({
          from: helpers.sshBranchGrants.keyOwnerUserId,
          to: helpers.users.id,
          optional: false,
        }),
        capsuleOwner: helpers.one.users({
          from: helpers.sshBranchGrants.capsuleOwnerUserId,
          to: helpers.users.id,
          optional: false,
        }),
        boundByAdmin: helpers.one.users({
          from: helpers.sshBranchGrants.boundByAdminUserId,
          to: helpers.users.id,
          optional: false,
        }),
        revokedByUser: helpers.one.users({
          from: helpers.sshBranchGrants.revokedByUserId,
          to: helpers.users.id,
          optional: true,
        }),
        capsule: helpers.one.capsules({
          from: helpers.sshBranchGrants.capsuleId,
          to: helpers.capsules.id,
          optional: false,
        }),
        branch: helpers.one.capsuleBranches({
          from: helpers.sshBranchGrants.branchId,
          to: helpers.capsuleBranches.id,
          optional: false,
        }),
        tickets: helpers.many.sshTickets(),
      },
      sshTickets: {
        publicKey: helpers.one.sshPublicKeys({
          from: helpers.sshTickets.publicKeyId,
          to: helpers.sshPublicKeys.id,
          optional: false,
        }),
        grant: helpers.one.sshBranchGrants({
          from: helpers.sshTickets.grantId,
          to: helpers.sshBranchGrants.id,
          optional: false,
        }),
        user: helpers.one.users({
          from: helpers.sshTickets.userId,
          to: helpers.users.id,
          optional: false,
        }),
        capsule: helpers.one.capsules({
          from: helpers.sshTickets.capsuleId,
          to: helpers.capsules.id,
          optional: false,
        }),
        branch: helpers.one.capsuleBranches({
          from: helpers.sshTickets.branchId,
          to: helpers.capsuleBranches.id,
          optional: false,
        }),
        relay: helpers.one.sshRelays({
          from: helpers.sshTickets.id,
          to: helpers.sshRelays.ticketId,
          optional: true,
        }),
      },
      sshRelays: {
        ticket: helpers.one.sshTickets({
          from: helpers.sshRelays.ticketId,
          to: helpers.sshTickets.id,
          optional: false,
        }),
        publicKey: helpers.one.sshPublicKeys({
          from: helpers.sshRelays.publicKeyId,
          to: helpers.sshPublicKeys.id,
          optional: false,
        }),
        user: helpers.one.users({
          from: helpers.sshRelays.userId,
          to: helpers.users.id,
          optional: false,
        }),
        capsule: helpers.one.capsules({
          from: helpers.sshRelays.capsuleId,
          to: helpers.capsules.id,
          optional: false,
        }),
        branch: helpers.one.capsuleBranches({
          from: helpers.sshRelays.branchId,
          to: helpers.capsuleBranches.id,
          optional: false,
        }),
      },
    },
    defineCapsuleRelations(helpers),
  ),
)
