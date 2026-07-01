/**
 * Standardized error codes for cross-module communication.
 */
export const GlobalErrorCode = {
  BAD_REQUEST: 'GBL_BAD_REQUEST',
  UNAUTHORIZED: 'GBL_UNAUTHORIZED',
  FORBIDDEN: 'GBL_FORBIDDEN',
  NOT_FOUND: 'GBL_NOT_FOUND',
  CONFLICT: 'GBL_CONFLICT',
  INTERNAL_ERROR: 'GBL_INTERNAL_ERROR',
  TIMEOUT: 'GBL_TIMEOUT',
} as const

export type GlobalErrorCode = (typeof GlobalErrorCode)[keyof typeof GlobalErrorCode]

/**
 * A standardized error class for cross-module communication.
 */
export class GlobalError extends Error {
  constructor(
    message: string,
    public readonly code: GlobalErrorCode = GlobalErrorCode.INTERNAL_ERROR,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'GlobalError'
  }
}
