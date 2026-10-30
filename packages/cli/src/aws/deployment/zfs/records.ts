import { AWS_RECORD_VERSION, AWS_SPEC } from '../../spec'
import { userId } from '../../host'
import { isErrorCode } from '../../../guards'
import { encodeRecord, sameJson } from '../../../json'
import { requireOperationLock } from '../../root'
import { stateFailure } from '../../errors'
import { InstallerError } from '../../../diagnostic/error'
import { readChild, writeChild, type Dir } from '../../../state/files'
import { bindingOf } from '../journal/binding'
import { isAppendOnly, isHistoryConsistent } from '../../../journal/history'
import { actionsOf, establishesPool, poolNameOf, zfsSchema, type ZfsRecord } from './types'
import type { Deployment } from '../types'

function invalid(): never {
  throw new InstallerError({
    code: 'ZFS_STATE_INVALID',
  })
}

/**
 * The record of a deployment with no preparation history. Null means the
 * deployment record lacks an identity, which callers treat as a defect.
 */
export function blank(deployment: Deployment): ZfsRecord | null {
  const binding = bindingOf(deployment)
  return binding === null
    ? null
    : { version: AWS_RECORD_VERSION.zfs, binding, authorizations: [], steps: [], pool: null }
}

/**
 * Pool evidence exists if and only if a create-pool or import-pool step was
 * verified. It names the pool of that step's approved plan, and for an import
 * the GUID and datasets of that plan. It sits on the recorded data volume, and
 * was observed after the step completed and no later than its verification. The
 * datasets of a created pool are recorded once a later dataset step was
 * verified, and not before.
 */
function isPoolConsistent({ pool, steps, authorizations, binding }: ZfsRecord): boolean {
  const index = steps.findLastIndex(
    step => step.completion !== null && step.verifiedAt !== null && establishesPool(step.action),
  )
  if (index < 0) {
    return pool === null
  }
  const established = steps[index]
  const plan = authorizations.find(({ id }) => id === established.authorization)?.plan
  const completedAt = established.completion?.completedAt
  const verifiedAt = established.verifiedAt
  if (pool === null || plan === undefined || completedAt === undefined || verifiedAt === null) {
    return false
  }
  const datasetsCreated = steps
    .slice(index + 1)
    .some(step => step.action === 'create-datasets' && step.verifiedAt !== null)
  return (
    pool.volumeId === binding.dataVolumeId &&
    pool.observedAt >= completedAt &&
    pool.observedAt <= verifiedAt &&
    poolNameOf(plan) === pool.name &&
    (plan.kind !== 'import' || plan.guid === pool.guid) &&
    (plan.kind === 'import' ? sameJson(pool.datasets, plan.datasets) : (pool.datasets !== null) === datasetsCreated)
  )
}

/**
 * Cross-field consistency of a record whose shape is already valid: it belongs
 * to this deployment, every step follows an existing authorization that allows
 * its action, only the last step may be unsettled, every storage plan targets
 * the recorded data volume, and the pool evidence agrees with the verified
 * steps.
 */
function isConsistent(record: ZfsRecord, deployment: Deployment): boolean {
  const { authorizations, binding } = record
  const bound = bindingOf(deployment)
  return (
    bound !== null &&
    sameJson(binding, bound) &&
    authorizations.every(({ plan }) => plan.kind === 'prerequisites' || plan.disk.volumeId === binding.dataVolumeId) &&
    isPoolConsistent(record) &&
    isHistoryConsistent(record, actionsOf)
  )
}

function parse(value: unknown, deployment: Deployment): ZfsRecord {
  const parsed = zfsSchema.safeParse(value)
  if (!parsed.success || !isConsistent(parsed.data, deployment)) {
    return invalid()
  }
  return parsed.data
}

/**
 * Lock-free so status can show evidence while an operation is running. An
 * absent file means no local preparation evidence, never a blank disk. Any
 * other failure fails closed, because it does not establish that no host
 * effects occurred.
 */
export async function read(directory: Dir, deployment: Deployment): Promise<ZfsRecord | null> {
  try {
    const snapshot = await readChild(directory, AWS_SPEC.state.zfs, {
      owner: userId(),
      mode: 0o600,
      minSize: 1,
      maxSize: AWS_SPEC.limits.zfs,
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
 * Whether this write is the one that verifies the last step, and that step is
 * the one that establishes pool evidence or records its datasets.
 */
function verifiesPool(before: ZfsRecord, after: ZfsRecord): boolean {
  const last = after.steps.at(-1)
  return (
    last !== undefined &&
    (establishesPool(last.action) || last.action === 'create-datasets') &&
    last.verifiedAt !== null &&
    before.steps.length === after.steps.length &&
    before.steps.at(-1)?.verifiedAt === null
  )
}

/**
 * Pool identity (name, GUID, volume) is immutable once recorded, and so are the
 * dataset GUIDs once they were recorded. The pool evidence changes only in the
 * write that verifies the create-pool, import-pool, or create-datasets step it
 * describes, and its observation time only advances.
 */
function requirePool(before: ZfsRecord, after: ZfsRecord): void {
  const { pool: previous } = before
  const { pool } = after
  if (
    previous !== null &&
    (pool === null ||
      previous.name !== pool.name ||
      previous.guid !== pool.guid ||
      previous.volumeId !== pool.volumeId ||
      pool.observedAt < previous.observedAt ||
      (previous.datasets !== null && !sameJson(previous.datasets, pool.datasets)))
  ) {
    return invalid()
  }
  if (!sameJson(previous, pool) && !verifiesPool(before, after)) {
    return invalid()
  }
}

/**
 * The journal's write rule: the binding is fixed, the history only grows by
 * the shared append-only rule, and the pool evidence follows its own rule.
 * Both records are already validated and consistent.
 */
function requireTransition(before: ZfsRecord, after: ZfsRecord): void {
  if (!sameJson(before.binding, after.binding) || !isAppendOnly(before, after)) {
    return invalid()
  }
  requirePool(before, after)
}

/**
 * Replaces the record only through a permitted transition, under the operation
 * lock held by this process. `directory` is the deployment's own directory.
 */
export async function save(root: Dir, directory: Dir, deployment: Deployment, record: ZfsRecord): Promise<void> {
  await requireOperationLock(root)
  const next = parse(record, deployment)
  const current = (await read(directory, deployment)) ?? blank(deployment)
  if (current === null) {
    return invalid()
  }
  requireTransition(current, next)
  try {
    await writeChild(directory, AWS_SPEC.state.zfs, encodeRecord(next, 'ZFS_STATE_INVALID', AWS_SPEC.limits.zfs), 0o600)
  } catch (error: unknown) {
    throw stateFailure(error)
  }
}
