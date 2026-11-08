import { basename } from 'node:path'
import { rm } from 'node:fs/promises'
import { z } from 'zod'
import { INSTALLER_SPEC } from '../spec'
import { readChain, type Chain } from './cert'
import { generateKey, keyPem, parseKey } from './csr'
import { requireInstallationLock } from '../state'
import { isErrorCode } from '../../guards'
import { encodeRecord } from '../../json'
import { InstallerError } from '../../diagnostic/error'
import { timestamp } from '../../journal/step'
import { readChild, writeChild, type Dir } from '../../state/files'
import { currentUserId } from '../../state/user'
import type { KeyObject } from 'node:crypto'

const NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const ZONE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/**
 * The allocation that the registration service made for one installation, with
 * the certificate chain once one was issued. `principal` is the operator the
 * allocation belongs to and `address` the host address its name points at. The
 * validity window is derived from the chain and never stored. Before the first
 * release, changing any literal or format rule resets local development state.
 * After it, a change needs a version bump and a versioned reader.
 */
export const domainSchema = z.strictObject({
  version: z.literal(INSTALLER_SPEC.domainVersion),
  installation: z.string().regex(NAME),
  principal: z.string().min(1).max(256),
  label: z.string().regex(LABEL),
  zone: z.string().regex(ZONE),
  address: z.ipv4(),
  chain: z.string().min(1).max(INSTALLER_SPEC.limits.domain).nullable(),
})

/**
 * Written before a request is dispatched and removed once its reply was judged
 * and persisted, so a marker that remains shows an attempt whose outcome was
 * never recorded. It is evidence for the operator, and nothing is blocked,
 * resumed, or replayed because of it.
 */
const attemptSchema = z.strictObject({
  kind: z.enum(['register', 'issue']),
  at: timestamp,
})

export type DomainRecord = z.infer<typeof domainSchema>
export type Attempt = z.infer<typeof attemptSchema>

/**
 * A record whose chain, when present, was judged against the retained key and
 * the allocated names.
 */
export interface Evidence {
  record: DomainRecord
  chain: Chain | null
}

/**
 * The apex name. The wildcard is `*.` followed by it.
 */
export function baseOf({ label, zone }: Pick<DomainRecord, 'label' | 'zone'>): string {
  return `${label}.${zone}`
}

function invalid(retry: string): never {
  throw new InstallerError({
    code: 'DOMAIN_STATE_INVALID',
    retry,
  })
}

/**
 * An absent file is null, and any other failure fails closed.
 */
async function load(directory: Dir, name: string, maxSize: number, retry: string): Promise<string | null> {
  try {
    const snapshot = await readChild(directory, name, {
      owner: currentUserId(),
      mode: 0o600,
      minSize: 1,
      maxSize,
    })
    return new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes)
  } catch (error: unknown) {
    return isErrorCode(error, 'ENOENT') ? null : invalid(retry)
  }
}

function parseJson(text: string, retry: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return invalid(retry)
  }
}

function parse(value: unknown, directory: Dir, key: KeyObject | null, retry: string): Evidence {
  const parsed = domainSchema.safeParse(value)
  if (!parsed.success || parsed.data.installation !== basename(directory.path)) {
    return invalid(retry)
  }
  const record = parsed.data
  if (record.chain === null) {
    return { record, chain: null }
  }
  const chain = key === null ? null : readChain(record.chain, key, baseOf(record))
  return chain === null ? invalid(retry) : { record, chain }
}

/**
 * The allocation is fixed once recorded, apart from the address its name points
 * at, and a retained chain is replaced but never dropped.
 */
function requireTransition(before: DomainRecord, after: DomainRecord, retry: string): void {
  const fixed =
    before.installation === after.installation &&
    before.principal === after.principal &&
    before.label === after.label &&
    before.zone === after.zone
  if (!fixed || (before.chain !== null && after.chain === null)) {
    invalid(retry)
  }
}

/**
 * Lock-free, so status can show evidence while an operation runs. Null means
 * no allocation is recorded. A chain without its key is invalid, because the
 * certificate cannot be used.
 */
export async function read(directory: Dir, retry: string): Promise<Evidence | null> {
  const text = await load(directory, INSTALLER_SPEC.state.domainFileName, INSTALLER_SPEC.limits.domain, retry)
  if (text === null) {
    return null
  }
  return parse(parseJson(text, retry), directory, await readKey(directory, retry), retry)
}

/**
 * Null means no TLS key is retained yet.
 */
export async function readKey(directory: Dir, retry: string): Promise<KeyObject | null> {
  const text = await load(directory, INSTALLER_SPEC.state.tlsKeyFileName, INSTALLER_SPEC.limits.tlsKey, retry)
  if (text === null) {
    return null
  }
  return parseKey(text) ?? invalid(retry)
}

/**
 * Returns the retained key, or generates and retains one. The key is stable
 * across renewals, and it is written before any certificate is requested for
 * it. Call it under the installation lock.
 */
export async function ensureKey(directory: Dir, retry: string): Promise<KeyObject> {
  await requireInstallationLock(directory, retry)
  const retained = await readKey(directory, retry)
  if (retained !== null) {
    return retained
  }
  await writeChild(directory, INSTALLER_SPEC.state.tlsKeyFileName, Buffer.from(keyPem(generateKey())), 0o600)
  return (await readKey(directory, retry)) ?? invalid(retry)
}

/**
 * Replaces the record only through a permitted transition, under the
 * installation lock held by this process.
 */
export async function save(directory: Dir, record: DomainRecord, retry: string): Promise<void> {
  await requireInstallationLock(directory, retry)
  const next = parse(record, directory, await readKey(directory, retry), retry)
  const current = await read(directory, retry)
  if (current !== null) {
    requireTransition(current.record, next.record, retry)
  }
  await writeChild(
    directory,
    INSTALLER_SPEC.state.domainFileName,
    encodeRecord(next.record, 'DOMAIN_STATE_INVALID', INSTALLER_SPEC.limits.domain),
    0o600,
  )
}

/**
 * Lock-free. Null means no attempt is outstanding.
 */
export async function readAttempt(directory: Dir, retry: string): Promise<Attempt | null> {
  const text = await load(directory, INSTALLER_SPEC.state.domainAttemptFileName, INSTALLER_SPEC.limits.domain, retry)
  if (text === null) {
    return null
  }
  const attempt = attemptSchema.safeParse(parseJson(text, retry))
  return attempt.success ? attempt.data : invalid(retry)
}

/**
 * Persists the marker before the request is dispatched, under the installation
 * lock, replacing any earlier one.
 */
export async function markAttempt(directory: Dir, kind: Attempt['kind'], retry: string): Promise<void> {
  await requireInstallationLock(directory, retry)
  const attempt: Attempt = { kind, at: new Date().toISOString() }
  await writeChild(
    directory,
    INSTALLER_SPEC.state.domainAttemptFileName,
    encodeRecord(attempt, 'DOMAIN_STATE_INVALID', INSTALLER_SPEC.limits.domain),
    0o600,
  )
}

/**
 * Removes the marker once the reply it covers was judged and persisted.
 */
export async function clearAttempt(directory: Dir, retry: string): Promise<void> {
  await requireInstallationLock(directory, retry)
  await rm(directory.child(INSTALLER_SPEC.state.domainAttemptFileName), { force: true })
  await directory.sync()
}
