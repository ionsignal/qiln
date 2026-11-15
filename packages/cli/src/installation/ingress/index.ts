import { createHash, type KeyObject } from 'node:crypto'
import { INSTALLER_SPEC } from '../spec'
import { caddyConfig } from './caddy'
import { keyPem } from '../registration/csr'
import { canonical } from '../../json'
import * as records from '../registration/records'
import type { Dir } from '../../state/files'
import type { IncusConfigMap } from '../../transport/incus/types'

const { keys, ports } = INSTALLER_SPEC.ingress
const ORIGIN_LINE = /^QILN_DEV_PUBLIC_ORIGIN=(.+)$/m

interface Tls {
  chain: string
  key: KeyObject
  fingerprint: string
}

/**
 * The generated ingress of one installation. `values` is what the stopped
 * instance must hold beside its credentials, and `digest` identifies it
 * without the private key. `origin`, `name` and the leaf `fingerprint` are for
 * display. A null fingerprint means TLS is terminated outside Qiln.
 */
export interface Ingress {
  name: string
  origin: string
  fingerprint: string | null
  digest: string
  values: IncusConfigMap
}

function overlay(origin: string, name: string): string {
  const lines = [
    `QILN_DEV_PUBLIC_ORIGIN=${origin}`,
    `QILN_ROUTING_PUBLIC_ORIGIN=${origin}`,
    `QILN_ROUTE_BASE_DOMAIN=${name}`,
    `QILN_SSH_PUBLIC_HOST=${name}`,
    `QILN_SSH_PUBLIC_PORT=${ports.gateway}`,
  ]
  return `${lines.join('\n')}\n`
}

/**
 * The key stays out of the digest because the certificate is already bound to it.
 * The origin is always https: a registered name is served with Qiln's own
 * certificate, and a local name is served behind the root edge, which owns TLS.
 */
function ingressOf(name: string, tls: Tls | null): Ingress {
  const origin = `https://${name}`
  const shared: IncusConfigMap = {
    [keys.environment]: overlay(origin, name),
    [keys.caddy]: caddyConfig(name, tls !== null),
    ...(tls === null ? {} : { [keys.certificate]: tls.chain }),
  }
  return {
    name,
    origin,
    fingerprint: tls?.fingerprint ?? null,
    digest: createHash('sha256').update(canonical(shared)).digest('hex'),
    values: tls === null ? shared : { ...shared, [keys.key]: keyPem(tls.key) },
  }
}

/**
 * The origin that an instance configuration was last delivered with, or null
 * when it holds none.
 */
export function deliveredOrigin(config: Readonly<IncusConfigMap>): string | null {
  return ORIGIN_LINE.exec(config[keys.environment] ?? '')?.[1] ?? null
}

/**
 * A public name supplied by the operator (a local target) is served as given.
 * Without one, the ingress is derived from retained registration evidence, so a
 * renewed certificate changes the result without touching the credential set.
 * Null means the registration evidence holds no certificate yet.
 */
export async function loadIngress(directory: Dir, publicName: string | null, retry: string): Promise<Ingress | null> {
  if (publicName !== null) {
    return ingressOf(publicName, null)
  }
  const evidence = await records.read(directory, retry)
  const key = await records.readKey(directory, retry)
  if (evidence === null || evidence.chain === null || evidence.record.chain === null || key === null) {
    return null
  }
  return ingressOf(records.baseOf(evidence.record), {
    chain: evidence.record.chain,
    key,
    fingerprint: evidence.chain.leaf.fingerprint256,
  })
}
