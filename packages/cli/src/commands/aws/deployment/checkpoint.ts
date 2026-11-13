import { InstallerError } from '../../../diagnostic/error'
import { optionsOf } from '../../../aws/deployment/ssh/access'
import { invalidRecord } from '../../../installation/records'
import { awsInstallationName } from '../../../installation/target/aws/host'
import { captureOn, headOn, type Probe } from '../../../installation/target/aws/checkout'
import {
  acquireInstallationLock,
  listInstallations,
  pinCheckout,
  readInstallation,
  type InstalledEntry,
} from '../../../installation/state'
import { withRemote } from './access'
import type { Dir } from '../../../state/files'
import type { Deployment } from '../../../aws/deployment/types'
import type { Prompts } from '../../../terminal/prompts'
import type { Reporter } from '../../../terminal/reporter'
import type { Remote } from '../../../transport/ssh/connections'

/**
 * The installation of the deployment's volume chain, read without locks or
 * authentication, so it can be resolved while this command holds the AWS lock.
 * Null means none is registered.
 */
export async function installationOf(record: Deployment): Promise<InstalledEntry | null> {
  const retry = `qiln installation status --id ${record.id}`
  const name = await awsInstallationName({ kind: 'id', value: record.id })
  return (await listInstallations(retry)).find(item => item.name === name) ?? null
}

/**
 * A restore point that was judged restorable and approved, and is recorded only
 * when `pin` runs. Nothing is written before that.
 */
export interface Checkpoint {
  pin(): Promise<void>
}

export function assignedTo(entry: InstalledEntry, record: Deployment): boolean {
  const { host } = entry.record
  return host.kind === 'aws' && host.deployment === record.id
}

/**
 * The HEAD of the managed checkout, judged restorable: the approved repository
 * is reachable and still serves it. Null means the checkout is absent. Every
 * refusal is decided before any host effect, and none has an override inside
 * Qiln.
 */
async function restorableOn(remote: Remote, path: string, retry: string): Promise<Probe | null> {
  if ((await headOn(remote, path, retry)) === null) {
    return null
  }
  const probe = await captureOn(remote, path, retry)
  if (!probe.origin) {
    throw new InstallerError({
      code: 'SOURCE_REF_UNRESOLVED',
      facts: [['Reason', 'The approved repository could not be reached, so the checkout commit cannot be proven restorable.']],
      retry,
    })
  }
  if (!probe.fetchable) {
    throw new InstallerError({
      code: 'SOURCE_CHECKOUT_UNPUSHED',
      facts: [
        ['Source checkout', path],
        ['HEAD', probe.head],
      ],
      retry,
    })
  }
  return probe
}

/**
 * Judges, before any host effect, whether the HEAD of the managed checkout may
 * become the restore point of the next host. Only a commit that the approved
 * repository still serves qualifies, because the guest's root volume, and the
 * checkout with it, is discarded with the host. A refusal has no override inside
 * Qiln, and deleting the checkout is the deliberate way to discard its work.
 * Null means there is nothing to record: no installation is assigned to this
 * deployment, its checkout is absent, or HEAD already is the restore point.
 * `announce` says whether those agreeing outcomes are reported. Something that
 * needs the operator is always reported, under a section opened only then.
 */
export async function planCheckpoint(
  record: Deployment,
  remote: Remote,
  prompts: Prompts,
  reporter: Reporter,
  retry: string,
  announce: boolean,
): Promise<Checkpoint | null> {
  const agreed = (outcome: 'pending' | 'reused', label: string, detail: string) => {
    if (announce) {
      reporter.section('Source checkout')
      reporter.row(outcome, label, detail)
    }
  }
  const entry = await installationOf(record)
  if (entry === null || !assignedTo(entry, record)) {
    agreed('pending', 'Installation', 'none is assigned to this deployment, so no restore point is recorded')
    return null
  }
  const { checkoutPath: path, checkoutCommit: restorePoint } = entry.record
  const probe = await restorableOn(remote, path, retry)
  if (probe === null) {
    agreed('reused', 'Checkout', `${path} is absent, so the recorded restore point stands unchanged`)
    return null
  }
  if (restorePoint === null) {
    throw new InstallerError({
      code: 'SOURCE_CHECKOUT_CONFLICT',
      facts: [['Reason', 'A checkout exists at the managed path, but no restore point is recorded for it.']],
      retry,
    })
  }
  if (probe.head === restorePoint) {
    agreed('reused', 'Restore point', `${path} · HEAD ${probe.head} is already recorded, and origin serves it`)
    return null
  }
  reporter.section('Source checkout')
  reporter.facts([
    ['Checkout', path],
    ['HEAD', probe.head],
    ['Restore point', `${restorePoint} recorded · would become ${probe.head}`],
    [
      'Origin',
      'HEAD was fetched from the approved repository into a throwaway repository just now, which is the operation that restores it on a replacement host',
    ],
  ])
  reporter.notice(
    'Only this commit is verified and recorded, and Qiln never pushes. Other local branches, stashes, uncommitted changes, and ignored files such as .env or node_modules are not preserved, because the root volume of the host is discarded with it. The restore point is written only after the Incus workloads are stopped.',
  )
  await prompts.approve('Record HEAD as the installation restore point')
  return {
    pin: async () => {
      const confirmed = await restorableOn(remote, path, retry)
      if (confirmed?.head !== probe.head) {
        throw new InstallerError({
          code: 'SOURCE_CHECKOUT_CHANGED',
          facts: [
            ['Source checkout', path],
            ['Approved HEAD', probe.head],
            ['Current HEAD', confirmed?.head ?? 'absent'],
          ],
          retry,
        })
      }
      const lock = await acquireInstallationLock(entry.directory, retry)
      try {
        const current = await readInstallation(entry.directory, retry)
        if (current === null || !assignedTo({ ...entry, record: current }, record)) {
          throw invalidRecord('The installation is no longer assigned to this deployment.', retry)
        }
        await pinCheckout(entry.directory, current, probe.head, retry)
        reporter.section('Restore point')
        reporter.row('verified', 'Recorded', `${probe.head} for the installation; origin was observed serving it`)
      } finally {
        await lock.release()
      }
    },
  }
}

/**
 * The last guard before AWS deletion. The checkpoint taken during the host
 * release can go stale while the removal approval waits, or between retries
 * after a refused step, so HEAD is judged again over a fresh connection. An
 * unchanged HEAD asks nothing and prints nothing, unpushed work refuses, and
 * pushed work needs a new approval. The retained host-key pin is used directly,
 * because `resolveAccess` refuses once removal has started. An unreachable host
 * is reported and removal continues, since cleanup must not depend on SSH.
 */
export async function confirmCheckpoint(
  root: Dir,
  record: Deployment,
  prompts: Prompts,
  reporter: Reporter,
  signal: AbortSignal,
): Promise<void> {
  const entry = await installationOf(record)
  const { hostKey } = record
  if (entry === null || !assignedTo(entry, record) || hostKey === null) {
    return
  }
  const retry = `qiln aws deployment remove --id ${record.id}`
  try {
    await withRemote(root, { record, options: optionsOf(record, hostKey), retry }, signal, async remote => {
      const checkpoint = await planCheckpoint(record, remote, prompts, reporter, retry, false)
      await checkpoint?.pin()
    })
  } catch (error: unknown) {
    if (!(error instanceof InstallerError) || error.code !== 'SSH_CONNECTION_FAILED') {
      throw error
    }
    reporter.notice(
      `The host could not be reached, so its source checkout was not checked. Commits made after the recorded restore point (${entry.record.checkoutCommit ?? 'none'}) are lost when the instance is terminated.`,
    )
  }
}
