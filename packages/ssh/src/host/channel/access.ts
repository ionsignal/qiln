import { CapsuleSshAccessCommandName, type CapsuleCommandHandlerOptions, type CapsuleChannel } from '@qiln/core/server'
import { mapSshCommandError } from './errors'
import type { SshPolicy } from '../policy'

/**
 * Registers SSH-authoritative lifecycle access handlers.
 *
 * These handlers use the owner identity encoded into the trusted private NATS
 * command target. They do not accept owner IDs independently from the payload.
 */
export function registerSshAccessHandlers(channel: CapsuleChannel, policy: SshPolicy): void {
  const options: CapsuleCommandHandlerOptions = {
    queue: 'qiln-ssh-host-policy',
    mapError: mapSshCommandError,
  }

  channel.handle(
    CapsuleSshAccessCommandName.BRANCH_ACCESS_INITIALIZE,
    async input => {
      return await policy.initializeBranchAccess(input.target.id, input.capsuleId, input.branchId, input.reason)
    },
    options,
  )

  channel.handle(
    CapsuleSshAccessCommandName.BRANCH_ACCESS_ENABLE,
    async input => {
      return await policy.enableBranchAccess(input.target.id, input.capsuleId, input.branchId)
    },
    options,
  )

  channel.handle(
    CapsuleSshAccessCommandName.BRANCH_ACCESS_REVOKE,
    async input => {
      return await policy.revokeBranchAccess(input.target.id, input.capsuleId, input.branchId, input.reason)
    },
    options,
  )

  channel.handle(
    CapsuleSshAccessCommandName.CAPSULE_ACCESS_REVOKE,
    async input => {
      return await policy.revokeCapsuleAccess(input.target.id, input.capsuleId, input.reason)
    },
    options,
  )
}
