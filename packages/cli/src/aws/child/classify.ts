import { InstallerError, type InstallerErrorCode } from '../../diagnostic/error'
import { isRecord } from '../guards'
import { COMMON_CODES, type CommonCode, type Failure } from './protocol'

type Names<Code extends InstallerErrorCode> = Readonly<Record<string, Failure<Code>>>

export function rejected<Code extends InstallerErrorCode>(code: Code): Failure<Code> {
  return {
    code,
    certainty: 'rejected',
  }
}

export function uncertain<Code extends InstallerErrorCode>(code: Code): Failure<Code> {
  return {
    code,
    certainty: 'uncertain',
  }
}

/**
 * Provider refusals that happen before any effect. Throttles, timeouts, and
 * unknown names are deliberately absent: they do not prove that nothing ran.
 */
const COMMON_NAMES: Names<CommonCode> = {
  CredentialsProviderError: rejected('AWS_AUTH_FAILED'),
  ExpiredToken: rejected('AWS_AUTH_EXPIRED'),
  ExpiredTokenException: rejected('AWS_AUTH_EXPIRED'),
  InvalidClientTokenId: rejected('AWS_AUTH_FAILED'),
  UnrecognizedClientException: rejected('AWS_AUTH_FAILED'),
  AccessDenied: rejected('AWS_ACCESS_DENIED'),
  AccessDeniedException: rejected('AWS_ACCESS_DENIED'),
  UnauthorizedOperation: rejected('AWS_ACCESS_DENIED'),
}

function lookup<Code extends InstallerErrorCode>(names: Names<Code>, name: string): Failure<Code> | undefined {
  return Object.hasOwn(names, name) ? names[name] : undefined
}

/**
 * Only allowlisted classifications leave the credential process. Provider
 * messages, request objects, and credential values are never returned.
 * `refusedCodes` lists local failures a child raises strictly before its
 * mutating call, which makes them definite refusals.
 */
export function classifier<Extra extends InstallerErrorCode>(
  extraCodes: readonly Extra[],
  extraNames: Names<Extra> = {},
  refusedCodes: readonly InstallerErrorCode[] = [],
) {
  const codes: readonly InstallerErrorCode[] = [...COMMON_CODES, ...extraCodes]
  const allowed = (code: InstallerErrorCode): code is CommonCode | Extra => codes.includes(code)
  return (error: unknown): Failure<CommonCode | Extra> => {
    // A diagnostic can be thrown after a provider call, so its effect stays
    // uncertain unless the child declared it a pre-dispatch refusal.
    if (error instanceof InstallerError && allowed(error.code)) {
      return refusedCodes.includes(error.code) ? rejected(error.code) : uncertain(error.code)
    }
    const name = isRecord(error) && typeof error.name === 'string' ? error.name : ''
    return lookup(extraNames, name) ?? lookup(COMMON_NAMES, name) ?? uncertain('AWS_REQUEST_FAILED')
  }
}
