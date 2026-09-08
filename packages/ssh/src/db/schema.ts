import type { PgColumn } from 'drizzle-orm/pg-core'
import { createAccessTable } from './access'
import { createGrantsTable } from './grants'
import { createKeysTable } from './keys'
import { createRelaysTable } from './relays'
import { createTicketsTable } from './tickets'

export interface SshSchemaBindings {
  users: {
    id: PgColumn
  }
  capsules: {
    id: PgColumn
  }
  capsuleBranches: {
    id: PgColumn
  }
}

/**
 * Composes SSH persistence against the Host's existing identity columns.
 *
 * The returned handles must be installed in the final Host schema and supplied
 * unchanged to SSH services.
 */
export function createSshSchema(bindings: SshSchemaBindings) {
  const userId = bindings.users.id
  const capsuleId = bindings.capsules.id
  const branchId = bindings.capsuleBranches.id
  const sshPublicKeys = createKeysTable(userId)
  const sshBranchAccess = createAccessTable(branchId)
  const sshBranchGrants = createGrantsTable({
    userId,
    capsuleId,
    branchId,
    publicKeyId: sshPublicKeys.id,
  })
  const sshTickets = createTicketsTable({
    userId,
    capsuleId,
    branchId,
    publicKeyId: sshPublicKeys.id,
    grantId: sshBranchGrants.id,
  })
  const sshRelays = createRelaysTable({
    userId,
    capsuleId,
    branchId,
    publicKeyId: sshPublicKeys.id,
    ticketId: sshTickets.id,
  })
  return {
    sshPublicKeys,
    sshBranchAccess,
    sshBranchGrants,
    sshTickets,
    sshRelays,
  }
}

export type SshTables = ReturnType<typeof createSshSchema>
