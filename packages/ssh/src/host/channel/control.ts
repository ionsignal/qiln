import { CapsuleSshControlCommandName, type CapsuleChannel, type CapsuleCommandHandlerOptions } from '@qiln/core/server'
import { mapSshCommandError } from './errors'
import type { SshPolicy } from '../policy'

/**
 * Registers management requests from authenticated Web publishers.
 *
 * The requester target is not an administrator assertion. Policy checks
 * administrator state and key ownership against the injected database.
 */
export function registerSshControlHandlers(channel: CapsuleChannel, policy: SshPolicy): void {
  const options: CapsuleCommandHandlerOptions = {
    queue: 'qiln-ssh-control',
    mapError: mapSshCommandError,
  }

  channel.handle(
    CapsuleSshControlCommandName.SSH_KEY_REGISTER,
    async input => {
      return await policy.registerPublicKey(input.target.id, {
        publicKey: input.publicKey,
        ...(input.label === undefined ? {} : { label: input.label }),
      })
    },
    options,
  )

  channel.handle(
    CapsuleSshControlCommandName.SSH_KEYS_LIST,
    async input => {
      return await policy.listPublicKeys(input.target.id)
    },
    options,
  )

  channel.handle(
    CapsuleSshControlCommandName.SSH_KEY_REVOKE,
    async input => {
      return await policy.revokePublicKey(input.target.id, input.publicKeyId)
    },
    options,
  )

  channel.handle(
    CapsuleSshControlCommandName.SSH_GRANT_BIND,
    async input => {
      return await policy.bindGrant(input.target.id, input.publicKeyId, input.branchId)
    },
    options,
  )

  channel.handle(
    CapsuleSshControlCommandName.SSH_GRANTS_LIST,
    async input => {
      return await policy.listGrants(input.target.id)
    },
    options,
  )

  channel.handle(
    CapsuleSshControlCommandName.SSH_GRANT_REVOKE,
    async input => {
      return await policy.revokeGrant(input.target.id, input.grantId)
    },
    options,
  )

  channel.handle(
    CapsuleSshControlCommandName.SSH_CONFIG,
    async input => {
      return await policy.generateOpenSshConfig(input.target.id, input.publicKeyId)
    },
    options,
  )
}
