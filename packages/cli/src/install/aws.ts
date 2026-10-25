import { InstallerError } from '../diagnostic/error'
import { optionsOf, requireReady } from '../aws/deployment/access'
import { evidence as incusEvidence } from '../aws/deployment/incus/evidence'
import { requireNotStuck as requireIncusNotStuck, retainedPreseed, storageHeld } from '../aws/deployment/incus/facts'
import { bindingOf } from '../aws/deployment/journal/binding'
import { requireNotStuck as requireZfsNotStuck } from '../aws/deployment/zfs/facts'
import { withAwsOperation } from '../aws/root'
import { devLayout, type Layout } from './layout'
import * as deployments from '../aws/deployment/records'
import * as lineage from '../aws/deployment/zfs/lineage'
import type { DeploymentSelector } from '../aws/deployment/alias'
import type { Deployment } from '../aws/deployment/types'
import type { IncusConfigMap } from '../incus/types'
import type { SshOptions } from '../ssh/options'
import type { Dir } from '../state/files'
import type { HostBinding } from './records'

/**
 * Proposed AWS policy: a memory limit and no CPU limit. Live target capacity
 * is checked by the installation workflow, not here.
 */
const LIMITS: Readonly<IncusConfigMap> = Object.freeze({
  'limits.memory': '16GiB',
})

/**
 * Everything an installation needs from one deployment, taken from retained
 * evidence alone. The host binding is the deployment's own identity, the layout
 * comes from its verified ZFS pool and retained Incus preseed, and the SSH
 * options use the retained host-key pin. `root` and `record` let the caller read
 * the administrative key with `readPrivateKey`. Architecture is not known here:
 * it is observed on the target.
 */
export interface AwsHost {
  host: HostBinding
  layout: Layout
  ssh: SshOptions
  record: Deployment
  root: Dir
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
 * Resolves the host under the AWS-operation lock, which stays held while `run`
 * executes. The caller acquires the installation lock inside `run`, so the lock
 * order is AWS state first, then installation state. Nothing here authenticates
 * to AWS, connects to the host, or writes evidence, and a missing host-key pin
 * is refused rather than retained.
 */
export async function withAwsHost<T>(
  selector: DeploymentSelector,
  run: (host: AwsHost) => Promise<T>,
): Promise<T> {
  return await withAwsOperation(false, async ({ root }) => {
    const record = await deployments.find(root, selector)
    if (!record) {
      throw new InstallerError({
        code: 'AWS_DEPLOYMENT_NOT_FOUND',
        facts: [[selector.kind === 'id' ? 'Deployment ID' : 'Deployment alias', selector.value]],
        retry: 'qiln aws deployment list',
      })
    }
    requireReady(record)
    requireZfsNotStuck(await lineage.evidence(root, record), record.id)
    const incus = await incusEvidence(root, record)
    requireIncusNotStuck(incus, record.id)
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
      throw refusal(record, 'Incus is not recorded as initialized and still running. Qiln never restarts it.')
    }
    const [network] = preseed.networks
    const bridge = /^(\d{1,3}(?:\.\d{1,3}){2})\.1\/24$/.exec(network.config['ipv4.address'] ?? '')
    if (bridge === null) {
      throw refusal(record, 'The retained bridge address is not a /24 network with a gateway ending in .1.')
    }
    const prefix = bridge[1]
    return await run({
      host: { kind: 'aws', ...identity },
      layout: {
        pool: { name: pool.name },
        network: { name: network.name, ipv4Subnet: `${prefix}.0/24`, config: network.config },
        postgres: devLayout.postgres,
        orchestrator: { ipv4Address: `${prefix}.10`, limits: LIMITS },
      },
      ssh: optionsOf(record, pin),
      record,
      root,
    })
  })
}
