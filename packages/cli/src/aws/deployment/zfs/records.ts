import { AWS_RECORD_VERSION, AWS_SPEC } from '../../spec'
import { userId } from '../../host'
import { isErrorCode } from '../../guards'
import { encodeRecord, sameJson } from '../../json'
import { requireOperationLock } from '../../root'
import { stateFailure } from '../../errors'
import { InstallerError } from '../../../diagnostic/error'
import { readChild, writeChild, type Dir } from '../../../state/files'
import { settled, stateOf } from './facts'
import { targetOf } from './target'
import { actionsOf, establishesPool, poolNameOf, zfsSchema, type ZfsBinding, type ZfsRecord, type ZfsStep } from './types'
import type { Deployment } from '../types'

function invalid(): never {
  throw new InstallerError({
    code: 'ZFS_STATE_INVALID',
  })
}

function bindingOf(deployment: Deployment): ZfsBinding | null {
  const target = targetOf(deployment)
  if (target === null) {
    return null
  }
  return {
    deployment: deployment.id,
    connection: deployment.connection,
    operator: deployment.binding.operator,
    region: deployment.binding.region,
    instanceId: target.instanceId,
    rootVolumeId: target.rootVolumeId,
    dataVolumeId: target.dataVolumeId,
  }
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
 * the GUID of that plan. It sits on the recorded data volume, and was observed
 * after the step completed and no later than its verification.
 */
function isPoolConsistent({ pool, steps, authorizations, binding }: ZfsRecord): boolean {
  const established = steps
    .flatMap(step =>
      step.completion !== null && step.verifiedAt !== null && establishesPool(step.action)
        ? [{ authorization: step.authorization, completedAt: step.completion.completedAt, verifiedAt: step.verifiedAt }]
        : [],
    )
    .at(-1)
  if (established === undefined) {
    return pool === null
  }
  const plan = authorizations.find(({ id }) => id === established.authorization)?.plan
  return (
    pool !== null &&
    pool.volumeId === binding.dataVolumeId &&
    pool.observedAt >= established.completedAt &&
    pool.observedAt <= established.verifiedAt &&
    plan !== undefined &&
    poolNameOf(plan) === pool.name &&
    (plan.kind !== 'import' || plan.guid === pool.guid)
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
  const { authorizations, steps, binding } = record
  const bound = bindingOf(deployment)
  return (
    bound !== null &&
    sameJson(binding, bound) &&
    new Set(authorizations.map(authorization => authorization.id)).size === authorizations.length &&
    new Set(steps.map(step => step.id)).size === steps.length &&
    authorizations.every(({ plan }) => plan.kind === 'prerequisites' || plan.disk.volumeId === binding.dataVolumeId) &&
    isPoolConsistent(record) &&
    steps.slice(0, -1).every(settled) &&
    steps.every((step, index) => {
      const authorization = authorizations.find(({ id }) => id === step.authorization)
      return (
        authorization !== undefined &&
        actionsOf(authorization.plan).includes(step.action) &&
        step.fencedAt >= authorization.approvedAt &&
        (index === 0 || steps[index - 1].fencedAt <= step.fencedAt)
      )
    })
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

function unchanged(before: readonly unknown[], after: readonly unknown[]): boolean {
  return before.length <= after.length && before.every((item, index) => sameJson(item, after[index]))
}

/**
 * Evidence is set once: a step keeps its identity, and its completion,
 * refusal, and verification are never rewritten or dropped.
 */
function progressed(before: ZfsStep, after: ZfsStep): boolean {
  return (
    before.id === after.id &&
    before.authorization === after.authorization &&
    before.action === after.action &&
    before.fencedAt === after.fencedAt &&
    (before.completion === null || sameJson(before.completion, after.completion)) &&
    (before.refusedAt === null || before.refusedAt === after.refusedAt) &&
    (before.verifiedAt === null || before.verifiedAt === after.verifiedAt)
  )
}

/**
 * Whether this write is the one that verifies the last step, and that step is
 * the one that establishes pool evidence.
 */
function verifiesPool(before: ZfsRecord, after: ZfsRecord): boolean {
  const last = after.steps.at(-1)
  return (
    last !== undefined &&
    establishesPool(last.action) &&
    last.verifiedAt !== null &&
    before.steps.length === after.steps.length &&
    before.steps.at(-1)?.verifiedAt === null
  )
}

/**
 * Pool identity (name, GUID, volume) is immutable once recorded. The pool
 * evidence changes only in the write that verifies the create-pool or
 * import-pool step it describes, and its observation time only advances.
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
      pool.observedAt < previous.observedAt)
  ) {
    return invalid()
  }
  if (!sameJson(previous, pool) && !verifiesPool(before, after)) {
    return invalid()
  }
}

/**
 * The journal's write rule: history is append-only, one write adds at most one
 * authorization or one fenced step but never both, a new authorization needs
 * every step settled, a new step starts open, and otherwise only the last step
 * may progress. Both records are already validated and consistent.
 */
function requireTransition(before: ZfsRecord, after: ZfsRecord): void {
  const authorized = after.authorizations.length - before.authorizations.length
  const fenced = after.steps.length - before.steps.length
  if (
    !sameJson(before.binding, after.binding) ||
    authorized < 0 ||
    authorized > 1 ||
    fenced < 0 ||
    fenced > 1 ||
    (authorized === 1 && fenced === 1) ||
    !unchanged(before.authorizations, after.authorizations)
  ) {
    return invalid()
  }
  requirePool(before, after)
  if (authorized === 1 && !after.steps.every(settled)) {
    return invalid()
  }
  if (fenced === 1) {
    if (!unchanged(before.steps, after.steps) || stateOf(after.steps[after.steps.length - 1]) !== 'open') {
      return invalid()
    }
    return
  }
  if (before.steps.length === 0) {
    return
  }
  if (
    !unchanged(before.steps.slice(0, -1), after.steps) ||
    !progressed(before.steps[before.steps.length - 1], after.steps[after.steps.length - 1])
  ) {
    return invalid()
  }
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
