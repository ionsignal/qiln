import { InstallerError } from '../../diagnostic/error'
import { renewAt } from './cert'
import type { Evidence } from './records'

/**
 * What the target says about itself right now: the operator that holds the
 * allocation and the address the name must point at.
 */
export interface Subject {
  principal: string
  address: string
}

/**
 * `register` makes the service record the allocation and its address, and
 * `issue` requests a certificate for the retained key.
 */
export type DomainPlan = { kind: 'current' } | { kind: 'acquire'; register: boolean; issue: boolean }

/**
 * Pure decision from retained evidence alone. Without evidence nothing exists,
 * so both are needed. A recorded allocation is registered again only when the
 * host address changed, and a certificate is requested when none is retained or
 * two thirds of its lifetime have passed. An allocation that belongs to another
 * operator is never replaced, because a second allocation would strand the
 * first.
 */
export function planOf(evidence: Evidence | null, subject: Subject, now: Date, retry: string): DomainPlan {
  if (evidence === null) {
    return { kind: 'acquire', register: true, issue: true }
  }
  const { record, chain } = evidence
  if (record.principal !== subject.principal) {
    throw new InstallerError({
      code: 'DOMAIN_ACQUISITION_REFUSED',
      facts: [
        ['Installation', record.installation],
        ['Allocated principal', record.principal],
        ['Deployment principal', subject.principal],
      ],
      retry,
    })
  }
  const register = record.address !== subject.address
  const issue = chain === null || now.getTime() >= renewAt(chain).getTime()
  return register || issue ? { kind: 'acquire', register, issue } : { kind: 'current' }
}
