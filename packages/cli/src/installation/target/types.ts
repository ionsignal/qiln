import type { IncusClient } from '../../transport/incus/client'
import type { DeploymentSelector } from '../../aws/deployment/volume/alias'
import type { Architecture } from '../architecture'
import type { Layout } from '../layout'
import type { HostBinding } from '../records'
import type { Retry } from '../retry'
import type { Reporter } from '../../terminal/reporter'

/**
 * The target of a named installation command: this machine, or one AWS
 * deployment selected by its immutable ID or local alias.
 */
export type InstallationSelector = { kind: 'local' } | DeploymentSelector

/**
 * The Incus daemon of a target. It is reachable only while the callback of
 * `HostAccess.withIncus` runs, because a remote target relays it through a
 * scoped connection. `verifyLayout` reports the storage and network checks of
 * the target's layout.
 */
export interface IncusAccess {
  client: IncusClient
  extensions: readonly string[]
  verifyLayout(): Promise<void>
}

/**
 * A validated target host. It is reachable only while the callback of
 * `InstallationTarget.withHost` runs. `checkout` validates a checkout path on
 * the target itself and returns its canonical root.
 */
export interface HostAccess {
  binding: HostBinding
  architecture: Architecture
  layout: Layout
  sshKeygen: string
  checkout(path: string): Promise<string>
  withIncus<T>(use: (incus: IncusAccess) => Promise<T>): Promise<T>
}

/**
 * Everything that differs between targets of the same installation workflow.
 * `name` is the installation name, and `retry` supplies the commands that
 * diagnostics tell the operator to run again. `signal` is the one cancellation
 * signal of the invocation: the Incus client of the target observes it, so
 * every request class decides for itself how to react.
 */
export interface InstallationTarget {
  name: string
  retry: Retry
  signal: AbortSignal
  withHost<T>(reporter: Reporter, retry: string, use: (host: HostAccess) => Promise<T>): Promise<T>
}
