import { TRPCError } from '@trpc/server'
import { IncusError } from '../errors'

/**
 * Centralized error handler for the QilnEngine tRPC boundary.
 */
export function handleHostError(error: unknown): never {
  if (error instanceof TRPCError) {
    throw error
  }
  if (error instanceof IncusError) {
    console.error(`[QilnEngine] Incus Error (${error.code}):`, error.message, error.details || '')
    switch (error.code) {
      case 'NOT_FOUND':
        throw new TRPCError({ code: 'NOT_FOUND', message: error.message, cause: error })
      case 'CONFLICT':
        throw new TRPCError({ code: 'CONFLICT', message: error.message, cause: error })
      case 'VALIDATION_ERROR':
        throw new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error })
      case 'FORBIDDEN':
        throw new TRPCError({ code: 'FORBIDDEN', message: error.message, cause: error })
      case 'API_ERROR':
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An internal infrastructure error occurred.', // Masked
          cause: error,
        })
      case 'TRANSPORT_ERROR':
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to communicate with the host infrastructure.', // Masked
          cause: error,
        })
      default:
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected infrastructure error occurred.',
          cause: error,
        })
    }
  }
  console.error('[QilnEngine] Unexpected Error:', error)
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'An unexpected error occurred.',
    cause: error instanceof Error ? error : undefined,
  })
}
