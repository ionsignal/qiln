import { AWS_RECORD_VERSION, AWS_SPEC } from '../../spec'
import { userId } from '../../host'
import { isErrorCode } from '../../../guards'
import { encodeRecord, sameJson } from '../../../json'
import { requireOperationLock } from '../../root'
import { stateFailure } from '../../errors'
import { InstallerError } from '../../../diagnostic/error'
import { readChild, writeChild, type Dir } from '../../../state/files'
import { readPreseed } from '../../../host/incus/preseed'
import { sha256Of } from '../../../host/incus/recipe'
import { opens, releases } from '../../../host/incus/spec'
import { actionsOf } from '../../../host/incus/types'
import { bindingOf } from '../journal/binding'
import { isAppendOnly, isHistoryConsistent } from '../../../journal/history'
import { establishes } from './facts'
import { incusSchema, type IncusRecord } from './types'
import type { Deployment } from '../types'

function invalid(): never {
  throw new InstallerError({
    code: 'AWS_INCUS_STATE_INVALID',
  })
}

/**
 * The record of a deployment with no Incus preparation history. Null means the
 * deployment record lacks an identity, which callers treat as a defect.
 */
export function blank(deployment: Deployment): IncusRecord | null {
  const binding = bindingOf(deployment)
  return binding === null
    ? null
    : { version: AWS_RECORD_VERSION.incus, binding, authorizations: [], steps: [], baseline: null, identity: null }
}

/**
 * Every retained preseed, whether approved for an initialization or carried by
 * the open of a preserved installation, must still hash to its approved digest
 * and read back as a preseed that Qiln would have produced, because
 * verification trusts it.
 */
function hasValidPreseeds({ authorizations }: IncusRecord): boolean {
  return authorizations.every(({ plan }) => {
    const preseed =
      plan.kind === 'initialize' ? plan.preseed : plan.kind === 'open' ? plan.retained?.preseed : undefined
    return preseed === undefined || (sha256Of(preseed.yaml) === preseed.sha256 && readPreseed(preseed.yaml) !== null)
  })
}

/**
 * Plans that name a pool all name the same one.
 */
function hasOnePool({ authorizations }: IncusRecord): boolean {
  const pools = authorizations.flatMap(({ plan }) =>
    plan.kind === 'guard' || plan.kind === 'open' || plan.kind === 'initialize' || plan.kind === 'release'
      ? [`${plan.pool}:${plan.guid}`]
      : [],
  )
  return new Set(pools).size <= 1
}

/**
 * A release step only makes sense after an open or initialization that was not
 * refused.
 */
function releasesFollowOpening({ steps }: IncusRecord): boolean {
  return steps.every(
    (step, index) =>
      !releases(step.action) ||
      steps.slice(0, index).some(earlier => opens(earlier.action) && earlier.refusedAt === null),
  )
}

/**
 * The baseline and the server identity exist if and only if an establishing
 * step was verified, because both are recorded in the write that verifies it.
 */
function isEstablishedWithStep(record: IncusRecord): boolean {
  const established = record.steps.some(step => establishes(record, step))
  return (record.baseline !== null) === established && (record.identity !== null) === established
}

/**
 * Cross-field consistency of a record whose shape is already valid: it belongs
 * to this deployment, every step follows an existing authorization that allows
 * its action, only the last step may be unsettled, and the retained plans agree
 * with each other.
 */
function isConsistent(record: IncusRecord, deployment: Deployment): boolean {
  const bound = bindingOf(deployment)
  return (
    bound !== null &&
    sameJson(record.binding, bound) &&
    hasValidPreseeds(record) &&
    hasOnePool(record) &&
    releasesFollowOpening(record) &&
    isEstablishedWithStep(record) &&
    isHistoryConsistent(record, actionsOf)
  )
}

function parse(value: unknown, deployment: Deployment): IncusRecord {
  const parsed = incusSchema.safeParse(value)
  if (!parsed.success || !isConsistent(parsed.data, deployment)) {
    return invalid()
  }
  return parsed.data
}

/**
 * Lock-free so status can show evidence while an operation is running. An
 * absent file means no local preparation evidence, never a pristine host. Any
 * other failure fails closed, because it does not establish that no host
 * effects occurred.
 */
export async function read(directory: Dir, deployment: Deployment): Promise<IncusRecord | null> {
  try {
    const snapshot = await readChild(directory, AWS_SPEC.state.incus, {
      owner: userId(),
      mode: 0o600,
      minSize: 1,
      maxSize: AWS_SPEC.limits.incus,
    })
    return parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes)) as unknown, deployment)
  } catch (error: unknown) {
    if (isErrorCode(error, 'ENOENT')) {
      return null
    }
    return invalid()
  }
}

/**
 * The baseline and the identity are set once, together, and only in the write
 * that verifies the newest step, which must be the establishing step they
 * describe. Neither is ever rewritten or dropped.
 */
function requireEstablished(before: IncusRecord, after: IncusRecord): void {
  if (before.baseline !== null) {
    if (!sameJson(before.baseline, after.baseline) || !sameJson(before.identity, after.identity)) {
      return invalid()
    }
    return
  }
  if (after.baseline === null) {
    return
  }
  const last = after.steps.at(-1)
  const previous = before.steps.at(-1)
  if (
    last === undefined ||
    !establishes(after, last) ||
    previous === undefined ||
    previous.verifiedAt !== null ||
    before.steps.length !== after.steps.length
  ) {
    return invalid()
  }
}

/**
 * The journal's write rule: the binding is fixed and the history only grows by
 * the shared append-only rule, while the baseline and the identity follow their
 * own. Both records are already validated.
 */
function requireTransition(before: IncusRecord, after: IncusRecord): void {
  if (!sameJson(before.binding, after.binding) || !isAppendOnly(before, after)) {
    return invalid()
  }
  requireEstablished(before, after)
}

/**
 * Replaces the record only through a permitted transition, under the operation
 * lock held by this process. `directory` is the deployment's own directory.
 */
export async function save(root: Dir, directory: Dir, deployment: Deployment, record: IncusRecord): Promise<void> {
  await requireOperationLock(root)
  const next = parse(record, deployment)
  const current = (await read(directory, deployment)) ?? blank(deployment)
  if (current === null) {
    return invalid()
  }
  requireTransition(current, next)
  try {
    await writeChild(directory, AWS_SPEC.state.incus, encodeRecord(next, 'AWS_INCUS_STATE_INVALID', AWS_SPEC.limits.incus), 0o600)
  } catch (error: unknown) {
    throw stateFailure(error)
  }
}
