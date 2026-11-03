import { InstallerError } from '../../../diagnostic/error'
import { outputOf } from '../../../host/output'
import { shellCommand } from '../../../host/shell'
import { runStep, type StepOutcome } from '../../../host/step'
import { SshError } from '../../../transport/ssh/failure'
import { CHECKOUT_SCRIPTS } from '../../checkout/manifest'
import { commitSchema } from '../../records'
import { INSTALLER_SPEC } from '../../spec'
import { inspectHost } from './inspect'
import type { Deployment } from '../../../aws/deployment/types'
import type { Remote } from '../../../transport/ssh/connections'
import type { CheckoutObservation } from '../../host'
import type { CheckoutAccess } from '../types'

const { repository, ref, directory, refusalCodes, resolve, capture, materialize } = INSTALLER_SPEC.checkout

/**
 * Runs `use` over one pinned, key-authenticated connection to the target.
 */
export type Shell = <T>(use: (remote: Remote) => Promise<T>) => Promise<T>

/**
 * What a read-only look at the managed checkout found. `fetchable` says that
 * HEAD could be fetched from the approved repository into a throwaway
 * repository, which is the operation that restores it.
 */
export interface Probe {
  head: string
  origin: boolean
  fetchable: boolean
}

interface ScriptSpec {
  timeoutMs: number
  maxOutputBytes: number
  refusals: Readonly<Record<number, string>>
}

function limitsOf({ timeoutMs, maxOutputBytes }: ScriptSpec) {
  return { timeoutMs, maxOutputBytes }
}

function reasonOf(exitCode: number, { refusals }: ScriptSpec): string {
  return exitCode >= refusalCodes.first && exitCode <= refusalCodes.last
    ? (refusals[exitCode] ?? 'The script refused before changing anything.')
    : `The script exited with code ${exitCode}.`
}

function conflict(reason: string, retry: string): InstallerError {
  return new InstallerError({
    code: 'SOURCE_CHECKOUT_CONFLICT',
    facts: [['Reason', reason]],
    retry,
  })
}

function unresolved(reason: string, retry: string): InstallerError {
  return new InstallerError({
    code: 'SOURCE_REF_UNRESOLVED',
    facts: [['Reason', reason]],
    retry,
  })
}

/**
 * The managed path is derived from the account that the deployment's bootstrap
 * creates, so it is the same on every host of a volume chain.
 */
function checkoutPath(record: Deployment): string {
  return `/home/${record.approval.host.plan.bootstrap.user}/${directory}`
}

/**
 * A present checkout must be exactly what Qiln would have cloned: at the managed
 * path, with the approved repository as origin, a committed HEAD, and the Qiln
 * package. HEAD and the working tree are never judged.
 */
function requireIdentity(checkout: CheckoutObservation, path: string, retry: string): string {
  if (checkout.path !== path) {
    throw conflict('The directory does not resolve to the managed path.', retry)
  }
  if (checkout.gitRoot !== path) {
    throw conflict('The directory is not the root of a Git work tree.', retry)
  }
  if (checkout.origin !== repository) {
    throw conflict('The checkout does not have the approved repository as its origin.', retry)
  }
  if (checkout.commit === null) {
    throw conflict('The checkout has no committed HEAD.', retry)
  }
  if (checkout.packageName !== 'qiln') {
    throw conflict("package.json must have name='qiln'.", retry)
  }
  return checkout.commit
}

/**
 * The HEAD of the managed checkout, or null when the directory is absent.
 */
export async function headOn(remote: Remote, path: string, retry: string): Promise<string | null> {
  const { checkout } = await inspectHost(remote, path)
  return checkout === null ? null : requireIdentity(checkout, path, retry)
}

/**
 * The current commit of the approved branch of the approved repository, asked
 * from the target.
 */
async function resolveOn(remote: Remote, retry: string): Promise<string> {
  const result = await remote.exec(shellCommand(CHECKOUT_SCRIPTS.resolve, [repository, ref]), limitsOf(resolve))
  if (result.exitCode !== 0) {
    throw unresolved(reasonOf(result.exitCode, resolve), retry)
  }
  const commit = commitSchema.safeParse(result.stdout.trim())
  if (!commit.success) {
    throw unresolved('The approved repository did not report a valid commit.', retry)
  }
  return commit.data
}

/**
 * Reads HEAD, and proves from a throwaway repository whether the approved
 * repository still serves it. The checkout itself is not changed.
 */
export async function captureOn(remote: Remote, path: string, retry: string): Promise<Probe> {
  const result = await remote.exec(shellCommand(CHECKOUT_SCRIPTS.capture, [path, repository]), limitsOf(capture))
  if (result.exitCode !== 0) {
    throw conflict(reasonOf(result.exitCode, capture), retry)
  }
  const { fields, yesNo } = outputOf(reason => conflict(reason, retry))
  const values = fields(result.stdout.split('\n'))
  const head = commitSchema.safeParse(values.get('head'))
  if (!head.success) {
    throw conflict('The checkout did not report a valid HEAD commit.', retry)
  }
  return {
    head: head.data,
    origin: yesNo(values.get('origin'), 'origin reachability'),
    fetchable: yesNo(values.get('fetchable'), 'HEAD fetchability'),
  }
}

async function materializeOn(remote: Remote, commit: string, path: string): Promise<StepOutcome> {
  return await runStep(remote, shellCommand(CHECKOUT_SCRIPTS.materialize, [repository, commit, path]), {
    ...limitsOf(materialize),
    refusals: materialize.refusals,
    refusalCodes,
  })
}

/**
 * The managed checkout of one deployment's host. Every call opens its own
 * session. A connection that ends before the clone was dispatched is a definite
 * absence of effect, so it is a refusal and never an open step. Anything else
 * that escapes the session stays unclassified, which leaves the step open.
 */
export function managedCheckout(record: Deployment, retry: string, shell: Shell): CheckoutAccess {
  const path = checkoutPath(record)
  return {
    kind: 'managed',
    path,
    head: () => shell(remote => headOn(remote, path, retry)),
    resolve: () => shell(remote => resolveOn(remote, retry)),
    materialize: async commit => {
      try {
        return await shell(remote => materializeOn(remote, commit, path))
      } catch (error: unknown) {
        if (error instanceof SshError && !error.remoteStarted) {
          return { kind: 'refused', reason: 'The connection ended before the step was dispatched.', cause: error }
        }
        throw error
      }
    },
  }
}
