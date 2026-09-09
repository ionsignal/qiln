import {
  createSshSchema,
  sshPublicKeyAlgorithmEnum,
  sshPublicKeyStatusEnum,
  sshBranchAccessStateEnum,
  sshBranchAccessBlockReasonEnum,
  sshBranchGrantStatusEnum,
  sshTicketStatusEnum,
  sshRelayStatusEnum,
} from '@qiln/ssh/server'
import { users } from './users'
import { capsuleTables } from './capsule'

/**
 * SSH-only physical composition. Web runtime modules must not import this
 * module or the complete migration schema.
 */
export const sshTables = createSshSchema({
  users,
  capsules: capsuleTables.capsules,
  capsuleBranches: capsuleTables.capsuleBranches,
})

export {
  sshPublicKeyAlgorithmEnum,
  sshPublicKeyStatusEnum,
  sshBranchAccessStateEnum,
  sshBranchAccessBlockReasonEnum,
  sshBranchGrantStatusEnum,
  sshTicketStatusEnum,
  sshRelayStatusEnum,
}

export const { sshPublicKeys, sshBranchAccess, sshBranchGrants, sshTickets, sshRelays } = sshTables

export const sshSchema = {
  sshPublicKeyAlgorithmEnum,
  sshPublicKeyStatusEnum,
  sshBranchAccessStateEnum,
  sshBranchAccessBlockReasonEnum,
  sshBranchGrantStatusEnum,
  sshTicketStatusEnum,
  sshRelayStatusEnum,
  ...sshTables,
} as const
