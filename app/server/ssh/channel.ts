import {
  CapsuleChannelErrorCode,
  CapsuleSshAccessCommandName,
  GlobalError,
  GlobalErrorCode,
  toCapsuleCommandFailure,
  type CapsuleCommandFailure,
  type CapsuleCommandHandlerOptions,
  type CapsuleChannel,
} from '@qiln/core/server'
import type { SshHostPolicy } from './policy'

function mapGlobalErrorCode(code: GlobalErrorCode): CapsuleChannelErrorCode {
  switch (code) {
    case GlobalErrorCode.BAD_REQUEST:
      return CapsuleChannelErrorCode.BAD_REQUEST
    case GlobalErrorCode.UNAUTHORIZED:
      return CapsuleChannelErrorCode.UNAUTHORIZED
    case GlobalErrorCode.FORBIDDEN:
      return CapsuleChannelErrorCode.FORBIDDEN
    case GlobalErrorCode.NOT_FOUND:
      return CapsuleChannelErrorCode.NOT_FOUND
    case GlobalErrorCode.CONFLICT:
      return CapsuleChannelErrorCode.CONFLICT
    case GlobalErrorCode.TIMEOUT:
      return CapsuleChannelErrorCode.TIMEOUT
    case GlobalErrorCode.INTERNAL_ERROR:
    default:
      return CapsuleChannelErrorCode.INTERNAL_ERROR
  }
}

function mapHostSshCommandError(error: unknown): CapsuleCommandFailure {
  if (error instanceof GlobalError) {
    return {
      code: mapGlobalErrorCode(error.code),
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    }
  }

  return toCapsuleCommandFailure(error, 'Internal Host SSH policy error.')
}

/**
 * Registers Host-authoritative SSH access-control handlers.
 *
 * These handlers use the owner identity encoded into the trusted private NATS
 * command target. They do not accept owner IDs independently from the payload.
 */
export function registerSshAccessControlHandlers(channel: CapsuleChannel, policy: SshHostPolicy): void {
  const options: CapsuleCommandHandlerOptions = {
    queue: 'qiln-ssh-host-policy',
    mapError: mapHostSshCommandError,
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
