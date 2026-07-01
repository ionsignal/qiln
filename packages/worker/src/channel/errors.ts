import { CapsuleChannelErrorCode, toCapsuleCommandFailure, type CapsuleCommandFailure } from '@qiln/core/server'
import { IncusError } from '../errors'

function incusErrorDetails(error: IncusError): Record<string, unknown> {
  const details: Record<string, unknown> = {
    message: error.message,
  }
  if (error.details !== undefined) {
    details.details = error.details
  }
  return details
}

/**
 * Maps privileged worker/runtime failures into the Capsule Channel failure model.
 *
 * Command handlers should throw domain/runtime errors. The channel owns the RPC
 * envelope and validates success outputs, so business failures must travel through
 * this mapper rather than through `{ success: false }` command return unions.
 */
export function mapWorkerCapsuleCommandError(error: unknown): CapsuleCommandFailure {
  if (error instanceof IncusError) {
    switch (error.code) {
      case 'VALIDATION_ERROR':
        return {
          code: CapsuleChannelErrorCode.BAD_REQUEST,
          message: error.message,
          details: incusErrorDetails(error),
        }
      case 'NOT_FOUND':
        return {
          code: CapsuleChannelErrorCode.NOT_FOUND,
          message: error.message,
          details: incusErrorDetails(error),
        }
      case 'CONFLICT':
        return {
          code: CapsuleChannelErrorCode.CONFLICT,
          message: error.message,
          details: incusErrorDetails(error),
        }
      case 'FORBIDDEN':
        return {
          code: CapsuleChannelErrorCode.FORBIDDEN,
          message: error.message,
          details: incusErrorDetails(error),
        }
      case 'TRANSPORT_ERROR':
        return {
          code: CapsuleChannelErrorCode.TRANSPORT_ERROR,
          message: error.message,
          details: incusErrorDetails(error),
        }
      case 'API_ERROR':
      default:
        return {
          code: CapsuleChannelErrorCode.INTERNAL_ERROR,
          message: error.message,
          details: incusErrorDetails(error),
        }
    }
  }
  return toCapsuleCommandFailure(error, 'Internal capsule branch runtime error.')
}
