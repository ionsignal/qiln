import { TRPCError } from '@trpc/server'
import { CapsuleChannelError, CapsuleChannelErrorCode, GlobalError, GlobalErrorCode } from '@qiln/core/server'

function handleGlobalError(error: GlobalError): never {
  switch (error.code) {
    case GlobalErrorCode.BAD_REQUEST:
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: error.message,
        cause: error,
      })
    case GlobalErrorCode.UNAUTHORIZED:
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: error.message,
        cause: error,
      })
    case GlobalErrorCode.FORBIDDEN:
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: error.message,
        cause: error,
      })
    case GlobalErrorCode.NOT_FOUND:
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: error.message,
        cause: error,
      })
    case GlobalErrorCode.CONFLICT:
      throw new TRPCError({
        code: 'CONFLICT',
        message: error.message,
        cause: error,
      })
    case GlobalErrorCode.TIMEOUT:
      throw new TRPCError({
        code: 'TIMEOUT',
        message: error.message,
        cause: error,
      })
    case GlobalErrorCode.INTERNAL_ERROR:
    default:
      console.error(`[QilnEngine] Global Error (${error.code}):`, error.message, error.details ?? '')
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An internal infrastructure error occurred.',
        cause: error,
      })
  }
}

function handleCapsuleChannelError(error: CapsuleChannelError): never {
  switch (error.code) {
    case CapsuleChannelErrorCode.BAD_REQUEST:
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: error.message,
        cause: error,
      })
    case CapsuleChannelErrorCode.UNAUTHORIZED:
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: error.message,
        cause: error,
      })
    case CapsuleChannelErrorCode.FORBIDDEN:
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: error.message,
        cause: error,
      })
    case CapsuleChannelErrorCode.NOT_FOUND:
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: error.message,
        cause: error,
      })
    case CapsuleChannelErrorCode.CONFLICT:
      throw new TRPCError({
        code: 'CONFLICT',
        message: error.message,
        cause: error,
      })
    case CapsuleChannelErrorCode.TIMEOUT:
      throw new TRPCError({
        code: 'TIMEOUT',
        message: error.message,
        cause: error,
      })
    case CapsuleChannelErrorCode.TRANSPORT_ERROR:
      console.error('[QilnEngine] Capsule Channel transport error:', error.message, error.details ?? '')
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to communicate with the capsule channel.',
        cause: error,
      })
    case CapsuleChannelErrorCode.INTERNAL_ERROR:
    default:
      console.error('[QilnEngine] Capsule Channel internal error:', error.message, error.details ?? '')
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An internal capsule channel error occurred.',
        cause: error,
      })
  }
}

/**
 * Centralized error handler for the QilnEngine tRPC boundary.
 *
 * Infrastructure-specific Worker errors cross the Capsule Channel as validated `CapsuleChannelError` instances.
 * The Engine does not depend on Incus error classes or provider implementation details.
 */
export function handleEngineError(error: unknown): never {
  if (error instanceof TRPCError) {
    throw error
  }
  if (error instanceof CapsuleChannelError) {
    handleCapsuleChannelError(error)
  }
  if (error instanceof GlobalError) {
    handleGlobalError(error)
  }
  console.error('[QilnEngine] Unexpected Error:', error)
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'An unexpected error occurred.',
    cause: error instanceof Error ? error : undefined,
  })
}
