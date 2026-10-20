import { DescribeAddressesCommand, GetConsoleOutputCommand } from '@aws-sdk/client-ec2'
import { AWS_SPEC } from '../../spec'
import { expectation, matches } from '../../deployment/expect'
import { hostKeySchema, type HostKey } from '../../deployment/hostkey'
import { resourceId } from '../../deployment/topology'
import { poll } from '../../observe'
import { hostKeyFingerprint } from './console'
import { observe } from '../observe'
import { byId, unverified } from '../observe/shared'
import type { Deployment } from '../../deployment/types'
import type { Ec2 } from '../client'

const HOST_KEY = {
  ...AWS_SPEC.deployment.hostKey.observation,
  code: 'AWS_DEPLOYMENT_HOST_KEY_UNVERIFIED',
} as const

interface ConsoleEvidence {
  fingerprint: string
  consoleAt: string
}

/**
 * The address comes only from the recorded allocation, never from operator
 * input, and its association must be the one the ledger expects.
 */
async function resolveAddress(ec2: Ec2, record: Deployment): Promise<{ allocationId: string; address: string }> {
  const expected = expectation(record).find(item => item.kind === 'address')
  if (expected === undefined || expected.association === null) {
    return unverified()
  }
  const response = await ec2.read((client, call) =>
    client.send(new DescribeAddressesCommand({ Filters: byId('allocation-id', [expected]) }), call),
  )
  const addresses = response.Addresses ?? []
  if (addresses.length !== 1) {
    return unverified()
  }
  const address = addresses[0]
  if (
    address.AllocationId !== expected.id ||
    address.Domain !== 'vpc' ||
    address.PublicIp === undefined ||
    address.AssociationId !== expected.association.id ||
    address.NetworkInterfaceId !== expected.association.interfaceId
  ) {
    return unverified()
  }
  return { allocationId: expected.id, address: address.PublicIp }
}

/**
 * One read. Output can be empty early in boot, which is not yet a failure, so
 * a missing fingerprint returns null and the caller keeps polling.
 */
async function readConsole(ec2: Ec2, instanceId: string, signal: AbortSignal): Promise<ConsoleEvidence | null> {
  const response = await ec2.read(
    (client, call) => client.send(new GetConsoleOutputCommand({ InstanceId: instanceId, Latest: true }), call),
    signal,
  )
  if (response.InstanceId !== instanceId) {
    return unverified()
  }
  const fingerprint = hostKeyFingerprint(response.Output)
  if (fingerprint === null) {
    return null
  }
  const timestamp = response.Timestamp
  if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
    return unverified()
  }
  return { fingerprint, consoleAt: timestamp.toISOString() }
}

/**
 * Resolves the recorded instance's Ed25519 host key from AWS-reported console
 * output. It never mutates, and never falls back to first-use acceptance: an
 * exhausted budget is an error that does not show the key is absent.
 */
export async function observeHostKey(ec2: Ec2, record: Deployment): Promise<HostKey> {
  const instanceId = resourceId(record, 'run-instances') ?? unverified()
  // One non-polled read must agree with the ledger before any evidence is read.
  if (!matches(expectation(record), await observe(ec2, record, false))) {
    return unverified()
  }
  const { allocationId, address } = await resolveAddress(ec2, record)
  const seen: { latest: ConsoleEvidence | null } = {
    latest: null,
  }
  await poll(async signal => {
    seen.latest = await readConsole(ec2, instanceId, signal)
    return seen.latest !== null
  }, HOST_KEY)
  const evidence = seen.latest ?? unverified()
  const parsed = hostKeySchema.safeParse({
    address,
    allocationId,
    instanceId,
    algorithm: 'ed25519',
    fingerprint: evidence.fingerprint,
    source: 'ec2-console',
    consoleAt: evidence.consoleAt,
    observedAt: new Date().toISOString(),
  })
  return parsed.success ? parsed.data : unverified()
}
