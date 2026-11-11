import type { Architecture } from './architecture'
import type { Layout } from './layout'
import type { DomainAccess } from './target/types'

/**
 * The host address and the TCP ports that the orchestrator publishes through
 * NAT proxy devices, so it sees real client addresses. A target without a
 * published address supplies none.
 */
export interface Publish {
  address: string
  ports: readonly number[]
}

/**
 * Where the public identity of the orchestrator comes from. A `domain` target
 * derives it from its acquired allocation and serves it over TLS. Any other
 * target is `direct`: it serves the orchestrator's layout address over HTTP.
 */
export type IngressMode = 'direct' | 'domain'

/**
 * Everything that varies between installations of the same workflow. The
 * checkout is the canonical path on the target, mounted writable at the
 * orchestrator's source path.
 */
export interface InstallationInputs {
  architecture: Architecture
  layout: Layout
  sourceRoot: string
  publish: Publish | null
  ingress: IngressMode
}

/**
 * The one place that assembles inputs from a validated host and its checkout
 * root.
 */
export function inputsOf(
  host: Omit<InstallationInputs, 'sourceRoot' | 'ingress'> & { domain: DomainAccess | null },
  sourceRoot: string,
): InstallationInputs {
  return {
    architecture: host.architecture,
    layout: host.layout,
    publish: host.publish,
    ingress: host.domain === null ? 'direct' : 'domain',
    sourceRoot,
  }
}
