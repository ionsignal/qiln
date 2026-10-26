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
import { actionsOf } from '../../../host/incus/types'
import { bindingOf } from '../journal/binding'
import { isAppendOnly, isHistoryConsistent } from '../../../journal/history'
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
    : { version: AWS_RECORD_VERSION.incus, binding, authorizations: [], steps: [], quiescence: null }
}

/**
 * Every retained preseed must still hash to its approved digest and read back
 * as a preseed that Qiln would have produced, because verification trusts it.
 */
function hasValidPreseeds({ authorizations }: IncusRecord): boolean {
  return authorizations.every(
    ({ plan }) =>
      plan.kind !== 'initialize' ||
      (sha256Of(plan.preseed.yaml) === plan.preseed.sha256 && readPreseed(plan.preseed.yaml) !== null),
  )
}

/**
 * Plans that name a pool all name the same one.
 */
function hasOnePool({ authorizations }: IncusRecord): boolean {
  const pools = authorizations.flatMap(({ plan }) =>
    plan.kind === 'initialize' || plan.kind === 'release' ? [`${plan.pool}:${plan.guid}`] : [],
  )
  return new Set(pools).size <= 1
}

/**
 * A release only makes sense after an initialization that was not refused.
 */
function releasesFollowInitialization({ steps }: IncusRecord): boolean {
  return steps.every(
    (step, index) =>
      step.action !== 'release' ||
      steps.slice(0, index).some(earlier => earlier.action === 'initialize' && earlier.refusedAt === null),
  )
}

/**
 * An observed inactivity is evidence about an initialization, so it cannot
 * predate the fence of one that was not refused.
 */
function observesAfterInitialization({ quiescence, steps }: IncusRecord): boolean {
  return (
    quiescence === null ||
    steps.some(
      step => step.action === 'initialize' && step.refusedAt === null && step.fencedAt <= quiescence.observedAt,
    )
  )
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
    releasesFollowInitialization(record) &&
    observesAfterInitialization(record) &&
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
 * The inactivity observation only advances, and the write that changes it
 * changes nothing else, so it can never alter or settle a step.
 */
function requireQuiescence(before: IncusRecord, after: IncusRecord): void {
  const { quiescence } = after
  if (sameJson(before.quiescence, quiescence)) {
    return
  }
  if (
    quiescence === null ||
    (before.quiescence !== null && quiescence.observedAt < before.quiescence.observedAt) ||
    !sameJson({ ...before, quiescence }, after)
  ) {
    return invalid()
  }
}

/**
 * The journal's write rule: the binding is fixed and the history only grows by
 * the shared append-only rule, while the inactivity observation follows its
 * own. Both records are already validated.
 */
function requireTransition(before: IncusRecord, after: IncusRecord): void {
  if (!sameJson(before.binding, after.binding) || !isAppendOnly(before, after)) {
    return invalid()
  }
  requireQuiescence(before, after)
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
