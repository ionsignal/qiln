import type { Retry } from '../retry'
import type { Layout } from '../layout'
import type { Publish } from '../types'
import type { HostBinding } from '../records'
import type { Window } from '../domain/cert'
import type { Subject } from '../domain/plan'
import type { StepOutcome } from '../../host/step'
import type { Architecture } from '../architecture'
import type { DomainRecord } from '../domain/records'
import type { Reporter } from '../../terminal/reporter'
import type { IncusClient } from '../../transport/incus/client'
import type { DeploymentSelector } from '../../aws/deployment/volume/alias'

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
 * The source checkout of a target.
 *
 * - operator: the operator's own checkout on this machine. `root` validates a
 *   named path and returns its canonical root.
 * - managed: the checkout that Qiln owns at a derived path on the target.
 *   `head` is the HEAD of the checkout, or null when it is absent, and it
 *   refuses a directory that is not a conforming checkout. `resolve` asks the
 *   approved repository for the current commit of its approved branch.
 *   `materialize` runs the one fenced clone script and reports how it ended, so
 *   the caller can journal it.
 */
export type CheckoutAccess =
  | { kind: 'operator'; root(path: string): Promise<string> }
  | {
      kind: 'managed'
      path: string
      head(): Promise<string | null>
      resolve(): Promise<string>
      materialize(commit: string): Promise<StepOutcome>
    }

/**
 * The registration service for the stable public name and wildcard certificate
 * of a target's installation. `service` names the service for the operator,
 * and `subject` is what retained evidence says the allocation is for. Each call
 * is one bounded request whose failures are already diagnostics, so the caller
 * never sees provider or process errors.
 */
export interface DomainAccess {
  service: string
  subject: Subject
  register(signal: AbortSignal): Promise<Pick<DomainRecord, 'label' | 'zone' | 'address'>>
  issue(csr: string, signal: AbortSignal): Promise<Window & { chain: string }>
}

/**
 * A validated target host. It is reachable only while the callback of
 * `InstallationTarget.withHost` runs. `publish` is the host address and ports
 * that the orchestrator publishes, or null when the target publishes none.
 * `domain` is null when the target owns no public name.
 */
export interface HostAccess {
  binding: HostBinding
  architecture: Architecture
  layout: Layout
  publish: Publish | null
  domain: DomainAccess | null
  sshKeygen: string
  checkout: CheckoutAccess
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
