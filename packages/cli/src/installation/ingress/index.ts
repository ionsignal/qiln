import { createHash, type KeyObject } from 'node:crypto'
import { INSTALLER_SPEC } from '../spec'
import { caddyConfig } from './caddy'
import { keyPem } from '../domain/csr'
import { canonical } from '../../json'
import * as records from '../domain/records'
import type { Dir } from '../../state/files'
import type { IncusConfigMap } from '../../transport/incus/types'
import type { InstallationInputs } from '../types'

const { keys, ports } = INSTALLER_SPEC.ingress

interface Tls {
  chain: string
  key: KeyObject
  fingerprint: string
}

/**
 * The generated ingress of one installation. `values` is what the stopped
 * instance must hold beside its credentials, and `digest` identifies it
 * without the private key. `origin`, `host` and the leaf `fingerprint` are for
 * display.
 */
export interface Ingress {
  host: string
  origin: string
  fingerprint: string | null
  digest: string
  values: IncusConfigMap
}

function overlay(origin: string, host: string): string {
  const lines = [
    `QILN_DEV_PUBLIC_ORIGIN=${origin}`,
    `QILN_ROUTING_PUBLIC_ORIGIN=${origin}`,
    `QILN_ROUTE_BASE_DOMAIN=${host}`,
    `QILN_SSH_PUBLIC_HOST=${host}`,
    `QILN_SSH_PUBLIC_PORT=${ports.gateway}`,
  ]
  return `${lines.join('\n')}\n`
}

/**
 * The key stays out of the digest because the certificate is already bound to it.
 */
function ingressOf(host: string, tls: Tls | null): Ingress {
  const origin = `${tls === null ? 'http' : 'https'}://${host}`
  const shared: IncusConfigMap = {
    [keys.environment]: overlay(origin, host),
    [keys.caddy]: caddyConfig(host, tls !== null),
    ...(tls === null ? {} : { [keys.certificate]: tls.chain }),
  }
  return {
    host,
    origin,
    fingerprint: tls?.fingerprint ?? null,
    digest: createHash('sha256').update(canonical(shared)).digest('hex'),
    values: tls === null ? shared : { ...shared, [keys.key]: keyPem(tls.key) },
  }
}

/**
 * Derived from retained evidence alone, so a renewed certificate changes the
 * result without touching the credential set. A domain target serves its
 * allocation over TLS, and any other target serves the orchestrator's layout
 * address over HTTP. Null means the domain evidence holds no certificate yet.
 */
export async function loadIngress(directory: Dir, inputs: InstallationInputs, retry: string): Promise<Ingress | null> {
  if (inputs.ingress === 'direct') {
    return ingressOf(inputs.layout.orchestrator.ipv4Address, null)
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
