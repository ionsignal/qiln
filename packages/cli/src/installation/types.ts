import type { Architecture } from './architecture'
import type { Layout } from './layout'

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
 * Everything that varies between installations of the same workflow. The
 * checkout is the canonical path on the target, mounted writable at the
 * orchestrator's source path.
 */
export interface InstallationInputs {
  architecture: Architecture
  layout: Layout
  sourceRoot: string
  publish: Publish | null
}

/**
 * The one place that assembles inputs from a validated host and its checkout
 * root.
 */
export function inputsOf(host: Omit<InstallationInputs, 'sourceRoot'>, sourceRoot: string): InstallationInputs {
  return { architecture: host.architecture, layout: host.layout, publish: host.publish, sourceRoot }
}
