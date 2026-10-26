import type { InstallerErrorCode } from '../../diagnostic/error'
import { hasKeys, isRecord } from '../../guards'

/**
 * `rejected` means the provider definitely refused the request, so it had no
 * effect. `uncertain` means the effect is unknown and must be recovered from
 * evidence. A rejected reply is sound only if the request made at most one
 * mutating provider call, and that call was the last provider call. A child
 * that cannot honor this rule must report every failure as uncertain.
 */
export type Certainty = 'rejected' | 'uncertain'

export interface Failure<Code extends InstallerErrorCode> {
  code: Code
  certainty: Certainty
}

/**
 * Every credential child answers with this envelope. Only allowlisted failure
 * codes cross the process boundary, never provider messages.
 */
export type ChildReply<Result, Code extends InstallerErrorCode> =
  | {
      ok: true
      result: Result
    }
  | {
      ok: false
      code: Code
      certainty: Certainty
    }

/**
 * Failures that any child may report. Each child's own code list must include
 * them, which its classifier guarantees by construction.
 */
export const COMMON_CODES = [
  'AWS_AUTH_FAILED',
  'AWS_AUTH_EXPIRED',
  'AWS_ACCESS_DENIED',
  'AWS_REQUEST_FAILED',
] as const satisfies readonly InstallerErrorCode[]

export type CommonCode = (typeof COMMON_CODES)[number]

export function replyGuard<Result, Code extends InstallerErrorCode>(
  isResult: (value: unknown) => value is Result,
  codes: readonly Code[],
): (value: unknown) => value is ChildReply<Result, Code> {
  return (value: unknown): value is ChildReply<Result, Code> => {
    if (!isRecord(value)) {
      return false
    }
    if (value.ok === true) {
      return hasKeys(value, ['ok', 'result']) && isResult(value.result)
    }
    return (
      value.ok === false &&
      hasKeys(value, ['ok', 'code', 'certainty']) &&
      codes.some(code => code === value.code) &&
      (value.certainty === 'rejected' || value.certainty === 'uncertain')
    )
  }
}
