import { CapsuleChannelErrorCode, type CapsuleCommandFailure } from '@qiln/core/server'
import { IncusError } from '../../errors'
import type { QilnWorkerRuntime } from '../../runtime'

function mapSshAuthorizedKeysSyncError(error: unknown): CapsuleCommandFailure {
  if (error instanceof IncusError) {
    switch (error.code) {
      case 'VALIDATION_ERROR':
        return {
          code: CapsuleChannelErrorCode.BAD_REQUEST,
          message: 'Branch SSH authorized-key synchronization request was invalid.',
        }
      case 'NOT_FOUND':
        return {
          code: CapsuleChannelErrorCode.NOT_FOUND,
          message: 'Branch SSH authorized-key synchronization target was not found.',
        }
      case 'CONFLICT':
        return {
          code: CapsuleChannelErrorCode.CONFLICT,
          message: 'Branch SSH authorized-key synchronization failed a safety check.',
        }
      case 'FORBIDDEN':
        return {
          code: CapsuleChannelErrorCode.FORBIDDEN,
          message: 'Branch SSH authorized-key synchronization was forbidden.',
        }
      case 'TRANSPORT_ERROR':
        return {
          code: CapsuleChannelErrorCode.TRANSPORT_ERROR,
          message: 'Branch SSH authorized-key synchronization could not reach the branch runtime.',
        }
      case 'API_ERROR':
      default:
        return {
          code: CapsuleChannelErrorCode.INTERNAL_ERROR,
          message: 'Branch SSH authorized-key synchronization failed.',
        }
    }
  }
  return {
    code: CapsuleChannelErrorCode.INTERNAL_ERROR,
    message: 'Branch SSH authorized-key synchronization failed.',
  }
}

/**
 * Registers the private Worker authorized-key synchronization responder.
 *
 * Detailed failures remain in Worker logs. Replies contain no key lines,
 * canonical file bytes, digests, provider payloads, or host paths.
 */
export function registerSshAuthorizedKeysSyncHandler(worker: QilnWorkerRuntime): void {
  worker.channel.handleSshAuthorizedKeysSync(
    async input => {
      try {
        return await worker.sshAuthorizedKeys.synchronize(input)
      } catch (error: unknown) {
        console.error(
          `[SshAuthorizedKeysSyncHandler] Failed to synchronize branch '${input.branchId}' in capsule '${input.capsuleId}'.`,
          error,
        )
        throw error
      }
    },
    {
      mapError: mapSshAuthorizedKeysSyncError,
    },
  )
}
