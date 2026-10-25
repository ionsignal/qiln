import { createHash, createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { INSTALLER_SPEC } from './spec'
import { InstallerError } from '../diagnostic/error'
import { bindingSchema } from '../aws/deployment/journal/binding'
import { canonical, sameJson } from '../aws/json'
import type { Layout } from './layout'
import type { InstallationInputs } from './types'

const sha256 = z.string().regex(/^[0-9a-f]{64}$/)

/**
 * The host an installation belongs to. A local host is identified by an
 * application-specific digest of the machine ID, which is binding evidence and
 * not attestation. An AWS host is the deployment's own retained identity.
 */
const hostSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('local'), machine: sha256 }),
  z.strictObject({ kind: z.literal('aws'), ...bindingSchema.shape }),
])

/**
 * One installation per host, because the instance name is fixed. Everything but
 * the image pin is fixed at registration, and the layout is kept as a digest.
 * The pin is null until an image has converged. Git provenance is deliberately
 * not part of the record. Before the first release, changing any literal or
 * format rule resets local development state.
 */
export const installationSchema = z.strictObject({
  version: z.literal(INSTALLER_SPEC.stateVersion),
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/),
  projectName: z.literal(INSTALLER_SPEC.projectName),
  instanceName: z.literal(INSTALLER_SPEC.orchestrator.name),
  host: hostSchema,
  architecture: z.enum(['amd64', 'arm64']),
  layout: sha256,
  checkoutPath: z.string().startsWith('/').max(4_096),
  imageFingerprint: sha256.nullable(),
})

export type HostBinding = z.infer<typeof hostSchema>
export type InstallationRecord = z.infer<typeof installationSchema>

export function invalidRecord(observed: string): InstallerError {
  return new InstallerError({
    code: 'INVALID_INSTALLATION_STATE',
    facts: [['Observed', observed]],
    retry: 'qiln doctor',
  })
}

function mismatch(subject: string): InstallerError {
  return new InstallerError({
    code: 'INSTALLATION_BINDING_MISMATCH',
    facts: [['Observed', `${subject} differs from the retained installation record.`]],
    retry: 'qiln doctor',
  })
}

/**
 * Binds the installation to this machine through a keyed digest, so the raw
 * machine ID is never retained or displayed.
 */
export async function localBinding(): Promise<HostBinding> {
  let id = ''
  try {
    id = (await readFile('/etc/machine-id', 'utf8')).trim()
  } catch {
    id = ''
  }
  if (!/^[0-9a-f]{32}$/.test(id)) {
    throw new InstallerError({
      code: 'INSTALLATION_HOST_UNIDENTIFIED',
      retry: 'qiln doctor',
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
    architecture: inputs.architecture.package,
    layout: layoutDigest(inputs.layout),
    checkoutPath: inputs.sourceRoot,
    imageFingerprint: null,
  }
}

export function requireHost(record: InstallationRecord, host: HostBinding): void {
  if (!sameHost(record.host, host)) {
    throw mismatch('The host identity')
  }
}

/**
 * Evidence is never rebound: a different host, architecture, layout, or
 * checkout path is refused.
 */
export function requireBound(record: InstallationRecord, host: HostBinding, inputs: InstallationInputs): void {
  requireHost(record, host)
  if (record.architecture !== inputs.architecture.package) {
    throw mismatch('The architecture')
  }
  if (record.layout !== layoutDigest(inputs.layout)) {
    throw mismatch('The layout')
  }
  if (record.checkoutPath !== inputs.sourceRoot) {
    throw mismatch('The checkout path')
  }
}

/**
 * The write rule: only the image pin may change. A destructive split-image
 * replacement is the one workflow that changes it. Both records are already
 * validated.
 */
export function requireTransition(before: InstallationRecord, after: InstallationRecord): void {
  if (!sameJson({ ...before, imageFingerprint: null }, { ...after, imageFingerprint: null })) {
    throw invalidRecord('A write may change only the image pin of an installation record.')
  }
}
