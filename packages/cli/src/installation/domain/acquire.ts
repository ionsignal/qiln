import { INSTALLER_SPEC } from '../spec'
import { csrOf } from './csr'
import { planOf, type DomainPlan } from './plan'
import { matches, readChain, type Chain, type Window } from './cert'
import { InstallerError } from '../../diagnostic/error'
import { checkCancellation } from '../../terminal/prompts'
import * as records from './records'
import type { KeyObject } from 'node:crypto'
import type { Dir } from '../../state/files'
import type { DomainAccess } from '../target/types'

export type Acquisition = Extract<DomainPlan, { kind: 'acquire' }>
export type DomainStep = records.Attempt['kind']

/**
 * `working` follows the start of a step, and `verified` follows only once the
 * reply was judged and persisted. A failed step emits nothing further, so the
 * failure diagnostic owns what the operator sees.
 */
export interface DomainProgress {
  phase: 'working' | 'verified'
  step: DomainStep
}

export interface Domain {
  record: records.DomainRecord
  chain: Chain
}

/**
 * The command owns presentation and consent. `approve` resolves only when the
 * operator approved the plan that `show` just displayed.
 */
export interface DomainHooks {
  show(plan: Acquisition): void
  approve(plan: Acquisition): Promise<void>
  progress(event: DomainProgress): void
}

export interface DomainContext {
  directory: Dir
  name: string
  access: DomainAccess
  hooks: DomainHooks
  retry: string
  signal: AbortSignal
}

/**
 * The steps one approved plan allows, in the order they run.
 */
export function actionsOf(plan: Acquisition): DomainStep[] {
  const actions: DomainStep[] = []
  if (plan.register) {
    actions.push('register')
  }
  if (plan.issue) {
    actions.push('issue')
  }
  return actions
}

function invalidState(retry: string): InstallerError {
  return new InstallerError({
    code: 'DOMAIN_STATE_INVALID',
    retry,
  })
}

function invalidReply(reason: string, retry: string): InstallerError {
  return new InstallerError({
    code: 'DOMAIN_RESPONSE_INVALID',
    facts: [['Reason', reason]],
    retry,
  })
}

/**
 * A certificate is retained only if it belongs to the retained key and the
 * allocated names, carries the window the service reported, and has not
 * expired. This is not path validation to a trust root.
 */
function requireChain(issued: Window & { chain: string }, key: KeyObject, base: string, retry: string): void {
  const chain = readChain(issued.chain, key, base)
  if (chain === null) {
    throw invalidReply('The chain does not match the retained key, the allocated names, or its own signatures.', retry)
  }
  if (!matches(chain, issued)) {
    throw invalidReply('The reported validity window differs from the certificate.', retry)
  }
  if (chain.notAfter.getTime() <= Date.now()) {
    throw invalidReply('The certificate has already expired.', retry)
  }
}

/**
 * The evidence as retained on disk. Acquisition always ends with a certificate,
 * so a record without one at this point is invalid.
 */
async function load(directory: Dir, retry: string): Promise<Domain> {
  const evidence = await records.read(directory, retry)
  if (evidence === null || evidence.chain === null) {
    throw invalidState(retry)
  }
  return { record: evidence.record, chain: evidence.chain }
}

/**
 * Cancellation is honored only after a received reply was persisted, so the
 * reply of a request that already took effect is never lost. A reply that names
 * another address than the one registered is rejected without being retained,
 * and the attempt marker stays as evidence.
 */
async function register(context: DomainContext, previous: records.DomainRecord | null): Promise<void> {
  const { directory, name, access, hooks, retry, signal } = context
  hooks.progress({ phase: 'working', step: 'register' })
  await records.markAttempt(directory, 'register', retry)
  const { label, zone, address } = await access.register(signal)
  if (address !== access.subject.address) {
    throw invalidReply('The service registered a different address than the one requested.', retry)
  }
  await records.save(
    directory,
    {
      version: INSTALLER_SPEC.domainVersion,
      installation: name,
      principal: access.subject.principal,
      label,
      zone,
      address,
      chain: previous?.chain ?? null,
    },
    retry,
  )
  await records.clearAttempt(directory, retry)
  hooks.progress({ phase: 'verified', step: 'register' })
  checkCancellation(signal)
}

/**
 * Reloads the allocation from the persisted record, because the registration
 * step may have just written it. The key is retained before the request, and
 * the CSR is rebuilt every time because ECDSA signatures are not deterministic
 * and the service recognizes the public key, not the CSR bytes.
 */
async function issue(context: DomainContext): Promise<void> {
  const { directory, access, hooks, retry, signal } = context
  const evidence = await records.read(directory, retry)
  if (evidence === null) {
    throw invalidState(retry)
  }
  const { record } = evidence
  const base = records.baseOf(record)
  hooks.progress({ phase: 'working', step: 'issue' })
  const key = await records.ensureKey(directory, retry)
  await records.markAttempt(directory, 'issue', retry)
  const issued = await access.issue(csrOf(key, base).toString('base64'), signal)
  requireChain(issued, key, base, retry)
  await records.save(directory, { ...record, chain: issued.chain }, retry)
  await records.clearAttempt(directory, retry)
  hooks.progress({ phase: 'verified', step: 'issue' })
  checkCancellation(signal)
}

/**
 * Brings the retained domain evidence of one installation up to date, under the
 * installation lock held by the command. The plan comes from retained evidence
 * alone, and one default-no approval covers it. Each step marks its attempt
 * before dispatch and clears the marker only after the reply was judged and
 * persisted, so an interrupted or uncertain attempt stays visible as evidence.
 * Nothing here resumes or replays it: the service is idempotent, and the
 * operator runs configure again. Errors propagate unwrapped, so unconfirmed
 * child termination keeps its lock.
 */
export async function acquire(context: DomainContext): Promise<Domain> {
  const { directory, access, hooks, retry } = context
  const evidence = await records.read(directory, retry)
  const plan = planOf(evidence, access.subject, new Date(), retry)
  if (plan.kind === 'current') {
    return await load(directory, retry)
  }
  hooks.show(plan)
  await hooks.approve(plan)
  if (plan.register) {
    await register(context, evidence?.record ?? null)
  }
  if (plan.issue) {
    await issue(context)
  }
  return await load(directory, retry)
}
