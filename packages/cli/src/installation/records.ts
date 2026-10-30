import { readFile } from 'node:fs/promises'
import { createHash, createHmac } from 'node:crypto'
import { z } from 'zod'
import { INSTALLER_SPEC } from './spec'
import { installationRetry } from './retry'
import { InstallerError } from '../diagnostic/error'
import { bindingSchema } from '../aws/deployment/journal/binding'
import { timestamp } from '../journal/step'
import { canonical, sameJson } from '../json'
import type { Layout } from './layout'
import type { InstallationInputs } from './types'

const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const localHost = z.strictObject({ kind: z.literal('local'), machine: sha256 })
const awsHost = z.strictObject({ kind: z.literal('aws'), ...bindingSchema.shape })

/**
 * One superseded AWS host, kept with the approval of the reassignment that
 * replaced it. The history is append-only evidence and grants no authority.
 */
const reassignmentSchema = z.strictObject({
  host: awsHost,
  reassignedAt: timestamp,
  approvedBy: z.strictObject({
    method: z.literal('local-interactive'),
    userId: z.int().nonnegative(),
  }),
})

/**
 * The host an installation belongs to. A local host is identified by an
 * application-specific digest of the machine ID, which is binding evidence and
 * not attestation. An AWS host is the deployment's own retained identity.
 */
export const hostSchema = z.discriminatedUnion('kind', [localHost, awsHost])

export type HostBinding = z.infer<typeof hostSchema>
export type AwsBinding = z.infer<typeof awsHost>
export type Reassignment = z.infer<typeof reassignmentSchema>

/**
 * Every host of one installation is a distinct deployment that holds the same
 * retained data volume, and only an AWS host is ever superseded.
 */
function isLineage(host: HostBinding, history: readonly Reassignment[]): boolean {
  if (history.length === 0) {
    return true
  }
  if (host.kind !== 'aws') {
    return false
  }
  const hosts: AwsBinding[] = [...history.map(entry => entry.host), host]
  return (
    new Set(hosts.map(item => item.deployment)).size === hosts.length &&
    hosts.every(item => item.dataVolumeId === host.dataVolumeId)
  )
}

/**
 * One installation per volume lineage, because the instance name is fixed.
 * Everything but the image pin and the host assignment is fixed at
 * registration, and the layout is kept as a digest. The pin is null until an
 * image has converged. `host` is the one current assignment, and `history`
 * holds the earlier ones. Git provenance is deliberately not part of the
 * record. Before the first release, changing any literal or format rule resets
 * local development state.
 */
export const installationSchema = z
  .strictObject({
    version: z.literal(INSTALLER_SPEC.stateVersion),
    name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/),
    projectName: z.literal(INSTALLER_SPEC.projectName),
    instanceName: z.literal(INSTALLER_SPEC.orchestrator.name),
    host: hostSchema,
    history: z.array(reassignmentSchema).max(32),
    architecture: z.enum(['amd64', 'arm64']),
    layout: sha256,
    checkoutPath: z.string().startsWith('/').max(4_096),
    imageFingerprint: sha256.nullable(),
  })
  .refine(({ host, history }) => isLineage(host, history), 'Expected earlier hosts of one retained volume.')

export type InstallationRecord = z.infer<typeof installationSchema>

export function invalidRecord(observed: string, retry: string): InstallerError {
  return new InstallerError({
    code: 'INVALID_INSTALLATION_STATE',
    facts: [['Observed', observed]],
    retry,
  })
}

function mismatch(subject: string, retry: string): InstallerError {
  return new InstallerError({
    code: 'INSTALLATION_BINDING_MISMATCH',
    facts: [['Observed', `${subject} differs from the retained installation record.`]],
    retry,
  })
}

/**
 * Binds the installation to this machine through a keyed digest, so the raw
 * machine ID is never retained or displayed.
 */
export async function localBinding(retry: string): Promise<HostBinding> {
  let id = ''
  try {
    id = (await readFile('/etc/machine-id', 'utf8')).trim()
  } catch {
    id = ''
  }
  if (!/^[0-9a-f]{32}$/.test(id)) {
    throw new InstallerError({
      code: 'INSTALLATION_HOST_UNIDENTIFIED',
      retry,
    })
  }
  return { kind: 'local', machine: createHmac('sha256', 'qiln:installation:host').update(id).digest('hex') }
}

export function sameHost(left: HostBinding, right: HostBinding): boolean {
  return sameJson(left, right)
}

function layoutDigest(layout: Layout): string {
  return createHash('sha256').update(canonical(layout)).digest('hex')
}

export function newRecord(name: string, host: HostBinding, inputs: InstallationInputs): InstallationRecord {
  return {
    version: INSTALLER_SPEC.stateVersion,
    name,
    projectName: INSTALLER_SPEC.projectName,
    instanceName: INSTALLER_SPEC.orchestrator.name,
    host,
    history: [],
    architecture: inputs.architecture.package,
    layout: layoutDigest(inputs.layout),
    checkoutPath: inputs.sourceRoot,
    imageFingerprint: null,
  }
}

/**
 * A different deployment of the same retained volume is not a different
 * installation: it is refused until the separately approved reassignment
 * records it. Any other host is never rebound.
 */
export function requireHost(record: InstallationRecord, host: HostBinding, retry: string): void {
  if (sameHost(record.host, host)) {
    return
  }
  if (record.host.kind === 'aws' && host.kind === 'aws' && record.host.dataVolumeId === host.dataVolumeId) {
    throw new InstallerError({
      code: 'INSTALLATION_REASSIGNMENT_REQUIRED',
      facts: [
        ['Assigned deployment', record.host.deployment],
        ['Selected deployment', host.deployment],
      ],
      retry: installationRetry({ kind: 'id', value: host.deployment }).reassign,
    })
  }
  throw mismatch('The host identity', retry)
}

/**
 * Evidence is never rebound: a different architecture, layout, or checkout
 * path is refused.
 */
export function requireInputs(record: InstallationRecord, inputs: InstallationInputs, retry: string): void {
  if (record.architecture !== inputs.architecture.package) {
    throw mismatch('The architecture', retry)
  }
  if (record.layout !== layoutDigest(inputs.layout)) {
    throw mismatch('The layout', retry)
  }
  if (record.checkoutPath !== inputs.sourceRoot) {
    throw mismatch('The checkout path', retry)
  }
}

export function requireBound(
  record: InstallationRecord,
  host: HostBinding,
  inputs: InstallationInputs,
  retry: string,
): void {
  requireHost(record, host, retry)
  requireInputs(record, inputs, retry)
}

/**
 * The write rule: a write changes either the image pin or the host assignment,
 * never both. A reassignment appends exactly one history entry, which is the
 * host it replaces. Both records are already validated.
 */
export function requireTransition(before: InstallationRecord, after: InstallationRecord, retry: string): void {
  const reassigned = after.history.length > before.history.length
  const valid = reassigned
    ? after.history.length === before.history.length + 1 &&
      sameJson(after.history.slice(0, -1), before.history) &&
      sameJson(after.history.at(-1)?.host, before.host) &&
      sameJson({ ...before, host: null, history: [] }, { ...after, host: null, history: [] })
    : sameJson({ ...before, imageFingerprint: null }, { ...after, imageFingerprint: null })
  if (!valid) {
    throw invalidRecord('A write may change only the image pin or append one host reassignment.', retry)
  }
}
