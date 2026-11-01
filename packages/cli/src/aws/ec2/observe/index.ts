import { expectation, matches, type Expected } from '../../deployment/observe/expect'
import { observationsSchema, type Deployment, type Observation } from '../../deployment/types'
import { poll, type PollOptions } from '../../observe'
import { accept } from '../../primitives'
import { AWS_SPEC } from '../../spec'
import { hostCandidates, observeHost } from './host'
import { networkCandidates, observeNetwork } from './network'
import { unverified } from './shared'
import type { Ec2 } from '../client'
import type { Polling } from '../protocol'

const { standard, termination } = AWS_SPEC.deployment.observation

const POLICIES: Record<Exclude<Polling, 'none'>, PollOptions> = {
  standard: { ...standard, code: 'AWS_DEPLOYMENT_VERIFICATION_FAILED' },
  termination: { ...termination, code: 'AWS_DEPLOYMENT_VERIFICATION_FAILED' },
}

/**
 * One graph observation comprises several provider reads, not one atomic read.
 * The implicit relationship is reported only by the instance read.
 */
async function snapshot(
  ec2: Ec2,
  record: Deployment,
  expected: readonly Expected[],
  signal?: AbortSignal,
): Promise<Observation> {
  const network = await observeNetwork(ec2, record, expected, signal)
  const host = await observeHost(ec2, record, expected, signal)
  return { observedAt: new Date().toISOString(), resources: [...network, ...host.resources], implicit: host.implicit }
}

/**
 * Judges every recorded resource against the ledger. With a polling policy it
 * polls until the whole graph matches, through missing, transitional, and not
 * yet propagated states; with `none`, one read is returned as observed.
 */
export async function observe(ec2: Ec2, record: Deployment, polling: Polling): Promise<Observation> {
  const expected = expectation(record)
  if (polling === 'none') {
    return await snapshot(ec2, record, expected)
  }
  const seen: { latest: Observation | undefined } = {
    latest: undefined,
  }
  await poll(async signal => {
    const observation = await snapshot(ec2, record, expected, signal)
    seen.latest = observation
    return matches(expected, observation)
  }, POLICIES[polling])
  return seen.latest ?? unverified()
}

export async function candidates(ec2: Ec2, record: Deployment): Promise<Observation[]> {
  const found = [...(await networkCandidates(ec2, record)), ...(await hostCandidates(ec2, record))]
  const observations = found.map(candidate => ({
    observedAt: new Date().toISOString(),
    resources: [candidate],
    implicit: null,
  }))
  return accept(observationsSchema, observations) ?? unverified()
}
