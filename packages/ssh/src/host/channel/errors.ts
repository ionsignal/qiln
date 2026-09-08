import { CapsuleChannelErrorCode, GlobalError, GlobalErrorCode, type CapsuleCommandFailure } from '@qiln/core/server'

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

/**
 * Database failures may contain SQL parameters, ticket hashes, or key material.
 * Internal RPC failures therefore expose only known domain messages and codes.
 */
export function mapSshCommandError(error: unknown): CapsuleCommandFailure {
  if (error instanceof GlobalError && error.code !== GlobalErrorCode.INTERNAL_ERROR) {
    return {
      code: mapGlobalErrorCode(error.code),
      message: error.message,
    }
  }

  return {
    code: CapsuleChannelErrorCode.INTERNAL_ERROR,
    message: 'Internal SSH policy error.',
  }
}
