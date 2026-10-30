import { INSTALLER_SPEC } from '../../spec'
import { InstallerError } from '../../../diagnostic/error'
import { notFound, type DeploymentSelector } from '../../../aws/deployment/alias'
import { optionsOf, requireReady } from '../../../aws/deployment/access'
import { chain, originOf } from '../../../aws/deployment/chain'
import { evidence as incusEvidence } from '../../../aws/deployment/incus/evidence'
import { bindingOf } from '../../../aws/deployment/journal/binding'
import { withConfirmedOperation } from '../../../aws/operation'
import { openAwsRoot } from '../../../aws/root'
import { readPrivateKey } from '../../../aws/ssh/private'
import { datasetNamesOf } from '../../../host/zfs/spec'
import { withSsh, type Remote } from '../../../transport/ssh/connections'
import { withSocket } from '../../../transport/ssh/socket'
import { devLayout, type Layout } from '../../layout'
import { requireSettled as requireZfsSettled } from '../../../aws/deployment/zfs/facts'
import { requireSettled as requireIncusSettled, retainedPreseed, storageHeld } from '../../../aws/deployment/incus/facts'
import * as deployments from '../../../aws/deployment/records'
import * as lineage from '../../../aws/deployment/zfs/lineage'
import type { Deployment } from '../../../aws/deployment/types'
import type { IncusConnection } from '../../../transport/incus/connection'
import type { IncusConfigMap } from '../../../transport/incus/types'
import type { Link } from '../../assignment'
import type { AwsBinding } from '../../records'

/**
 * Proposed AWS policy: a memory limit and no CPU limit. The installation
 * workflow compares the limit with the memory the target reports.
 */
const LIMITS: Readonly<IncusConfigMap> = Object.freeze({
  'limits.memory': '16GiB',
})

/**
 * Instance settings beyond the limits. An unset `boot.autostart` restores an
 * instance's previous state when the daemon starts, so a retained orchestrator
 * must never resume by itself when Incus is reopened.
 */
const CONFIG: Readonly<IncusConfigMap> = Object.freeze({
  'boot.autostart': 'false',
})

/**
 * The relay session never observes the command signal. Cancellation reaches the
 * Incus requests through the client instead, so a request that is allowed to
 * finish keeps its connection, exactly as it does on a local socket. The
 * session closes when the work that uses it unwinds.
 */
const RELAY_SIGNAL = new AbortController().signal

/**
 * Derived from the immutable ID of the deployment that created the retained
 * data volume, never from an alias or operator input, and within the
 * installation name rule. Every later deployment of the same volume chain keeps
 * the name, so a host replacement keeps the installation directory.
 */
function installationName(originId: string): string {
  return `aws-${originId}`
}

/**
 * Everything an installation needs from one deployment, taken from retained
 * evidence alone. The host binding is the deployment's own identity, and the
 * layout comes from its verified ZFS pool and retained Incus preseed. `links`
 * reads the preparation evidence of the whole volume chain, newest first, for
 * the host reassignment. `shell` and `relay` open one pinned, key-authenticated
 * connection for the duration of `use`: the administrative private key is read
 * for that connection only and zeroed afterwards, so it never leaves this
 * module. Architecture is not known here: it is observed on the target.
 */
export interface AwsHost {
  name: string
  host: AwsBinding
  layout: Layout
  record: Deployment
  links(): Promise<Link[]>
  shell<T>(signal: AbortSignal, use: (remote: Remote) => Promise<T>): Promise<T>
  relay<T>(use: (connection: IncusConnection) => Promise<T>): Promise<T>
}

function refusal(record: Deployment, reason: string): InstallerError {
  return new InstallerError({
    code: 'AWS_INSTALLATION_BINDING_REFUSED',
    facts: [
      ['Deployment', record.id],
      ['Reason', reason],
    ],
    retry: `qiln aws deployment prepare --id ${record.id}`,
  })
}

/**
 * The installation name of a deployment, read without locks or authentication,
 * so status can resolve an alias while another operation runs.
 */
export async function awsInstallationName(selector: DeploymentSelector): Promise<string> {
  const root = await openAwsRoot()
  if (root === null) {
    throw notFound(selector)
  }
  return installationName(await originOf(root, await deployments.select(root, selector)))
}

/**
 * Resolves the host under the AWS-operation lock, which stays held while `run`
 * executes, after refusing any retained unconfirmed child termination. The
 * caller acquires the installation lock inside `run`, so the lock order is AWS
 * state first, then installation state. Nothing here authenticates to AWS or
 * writes evidence, and a missing host-key pin is refused rather than retained.
 * Every unsettled preparation step on either side blocks the handoff,
 * including a returned step not yet verified. The retained preseed is the one
 * of the verified initialization, or of the verified reopen of a preserved
 * installation.
 */
export async function withAwsHost<T>(
  selector: DeploymentSelector,
  run: (host: AwsHost) => Promise<T>,
): Promise<T> {
  return await withConfirmedOperation(false, async ({ root }) => {
    const record = await deployments.select(root, selector)
    requireReady(record)
    requireZfsSettled(await lineage.evidence(root, record), record.id)
    const incus = await incusEvidence(root, record)
    requireIncusSettled(incus, record.id)
    const pin = record.hostKey
    const identity = bindingOf(record)
    const pool = await lineage.pool(root, record)
    const preseed = retainedPreseed(incus)
    if (pin === null) {
      throw refusal(record, 'No host-key pin is retained. Run verify or prepare first.')
    }
    if (identity === null) {
      throw refusal(record, 'The deployment record lacks a host identity.')
    }
    if (pool === null || !pool.ready) {
      throw refusal(record, 'The recorded ZFS pool is not verified imported with its scrub timer.')
    }
    if (preseed === null || !storageHeld(incus)) {
      throw refusal(record, 'Incus is not recorded as initialized or reopened and still running. Qiln never restarts it.')
    }
    const [network] = preseed.networks
    const bridge = /^(\d{1,3}(?:\.\d{1,3}){2})\.1\/24$/.exec(network.config['ipv4.address'] ?? '')
    if (bridge === null) {
      throw refusal(record, 'The retained bridge address is not a /24 network with a gateway ending in .1.')
    }
    const prefix = bridge[1]
    const ssh = optionsOf(record, pin)
    const withKey = async <R>(use: (key: Buffer) => Promise<R>): Promise<R> => {
      const key = await readPrivateKey(root, record)
      try {
        return await use(key)
      } finally {
        key.fill(0)
      }
    }
    return await run({
      name: installationName(await originOf(root, record)),
      host: { kind: 'aws', ...identity },
      layout: {
        pool: { name: pool.name, source: datasetNamesOf(pool.name).incus },
        network: { name: network.name, ipv4Subnet: `${prefix}.0/24`, config: network.config },
        postgres: devLayout.postgres,
        orchestrator: { ipv4Address: `${prefix}.10`, limits: LIMITS, config: CONFIG },
      },
      record,
      links: async () => {
        const links: Link[] = []
        for await (const deployment of chain(root, record)) {
          links.push({
            deployment,
            zfs: await lineage.evidence(root, deployment),
            incus: await incusEvidence(root, deployment),
          })
        }
        return links
      },
      shell: (signal, use) => withKey(key => withSsh(ssh, key, signal, use)),
      relay: use =>
        withKey(key => withSocket(ssh, key, RELAY_SIGNAL, INSTALLER_SPEC.incus.socketPath, use)),
    })
  })
}
