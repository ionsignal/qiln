import { IAMClient } from '@aws-sdk/client-iam'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { InstallerError } from '../../diagnostic/error'
import { configuration, credentials, expiresAt } from '../auth/credentials'
import { isSpec } from '../foundation/policy'
import { sameJson } from '../json'
import { AWS_SPEC } from '../spec'
import type { AwsConnection } from '../types'
import { Iam } from './client'
import { childContext } from './journal'
import { retainPassword } from './password'
import type { Request, Result } from './protocol'
import { authorize } from './transitions'
import {
  isRootIdentity,
  type Binding,
  type FoundationChange,
  type MutationResult,
  type Pending,
  type RootIdentity,
  type Target,
} from './types'

function invalid(): never {
  throw new InstallerError({
    code: 'AWS_PERMISSION_STATE_INVALID',
  })
}

function rootIdentity(value: { accountId: unknown; arn: unknown; userId: unknown }): RootIdentity {
  const identity = {
    accountId: value.accountId,
    arn: value.arn,
  }
  if (!isRootIdentity(identity) || value.userId !== identity.accountId) {
    throw new InstallerError({
      code: 'AWS_ROOT_REQUIRED',
    })
  }
  return identity
}

function target(record: Pending, accountId: string): Target {
  return {
    accountId,
    connection: record.name,
    creationId: record.creationId,
  }
}

function operatorBinding(record: Pending): Binding {
  if (!record.operator || record.accountId === null) {
    return invalid()
  }
  return {
    ...target(record, record.accountId),
    operator: record.operator,
  }
}

function foundationChange(record: Pending): FoundationChange {
  const mutation = record.mutation
  const returned = mutation?.returned
  if (!mutation?.before || returned?.kind !== 'policy' || returned.action !== mutation.action) {
    return invalid()
  }
  const action =
    mutation.action === 'create-foundation'
      ? 'create'
      : mutation.action === 'attach-foundation'
        ? 'attach'
        : mutation.action === 'replace-foundation'
          ? 'replace'
          : null
  if (action === null) {
    return invalid()
  }
  return {
    action,
    before: mutation.before,
    policy: returned.policy,
  }
}

async function inspect(
  iam: Iam,
  record: Pending,
  connection: AwsConnection | null,
  identity: RootIdentity,
  expiration: string,
  mfaConfigured: boolean,
): Promise<Result> {
  if (record.kind === 'onboard') {
    const intended = target(record, identity.accountId)
    await iam.absent(intended)
    await iam.foundationAbsent(intended)
    return {
      kind: 'inspection',
      inspection: {
        root: {
          identity,
          expiresAt: expiration,
          mfaConfigured,
        },
        signIn: await iam.review(),
        before: null,
      },
    }
  }
  if (!connection?.managed) {
    return invalid()
  }
  const before = await iam.inspectFoundation(operatorBinding(record), connection.managed.foundation)
  return {
    kind: 'inspection',
    inspection: {
      root: {
        identity,
        expiresAt: expiration,
        mfaConfigured,
      },
      signIn: before.signIn,
      before,
    },
  }
}

async function mutate(iam: Iam, record: Pending, signal: AbortSignal): Promise<MutationResult> {
  const approval = record.approval
  const mutation = record.mutation
  if (
    !approval ||
    !mutation ||
    record.accountId === null ||
    !isSpec(approval.permission, record.accountId, record.name)
  ) {
    return invalid()
  }
  const signIn = approval.inspection.signIn
  if (mutation.action === 'create-user') {
    return {
      kind: 'operator',
      identity: await iam.create(target(record, record.accountId), signIn),
    }
  }
  const operator = operatorBinding(record)
  switch (mutation.action) {
    case 'attach-signin':
      await iam.attach(operator, signIn)
      return {
        kind: 'done',
        action: 'attach-signin',
      }
    case 'grant-self':
      await iam.grant(operator, signIn)
      return {
        kind: 'done',
        action: 'grant-self',
      }
    case 'create-foundation':
      if (!mutation.before) {
        return invalid()
      }
      return {
        kind: 'policy',
        action: 'create-foundation',
        policy: await iam.createFoundation(operator, approval.permission, mutation.before),
      }
    case 'attach-foundation':
      if (!mutation.before) {
        return invalid()
      }
      return {
        kind: 'policy',
        action: 'attach-foundation',
        policy: await iam.attachFoundation(operator, mutation.before),
      }
    case 'replace-foundation':
      if (!mutation.before) {
        return invalid()
      }
      return {
        kind: 'policy',
        action: 'replace-foundation',
        policy: await iam.replaceFoundation(operator, approval.permission, mutation.before),
      }
    case 'password':
      if (!record.foundation) {
        return invalid()
      }
      return {
        kind: 'password',
        receipt: await iam.password(operator, signIn, record.foundation, receipt =>
          retainPassword(record.id, mutation.id, receipt, signal),
        ),
      }
  }
}

async function verifyMutation(iam: Iam, record: Pending): Promise<MutationResult> {
  const mutation = record.mutation
  const returned = mutation?.returned
  const signIn = record.approval?.inspection.signIn
  if (!mutation || !returned || !signIn) {
    return invalid()
  }
  const operator = operatorBinding(record)
  switch (mutation.action) {
    case 'create-user':
      if (returned.kind !== 'operator') {
        return invalid()
      }
      await iam.verifyUser(operator, signIn)
      break
    case 'attach-signin':
      if (returned.kind !== 'done' || returned.action !== 'attach-signin') {
        return invalid()
      }
      await iam.verifyStage(operator, signIn, 'signin')
      break
    case 'grant-self':
      if (returned.kind !== 'done' || returned.action !== 'grant-self') {
        return invalid()
      }
      await iam.verifyStage(operator, signIn, 'self')
      break
    case 'create-foundation':
    case 'attach-foundation':
    case 'replace-foundation':
      await iam.verifyFoundationChange(operator, foundationChange(record))
      break
    case 'password':
      if (returned.kind !== 'password' || !record.foundation) {
        return invalid()
      }
      await iam.verifyFoundation(operator, signIn, record.foundation)
      await iam.verifyPassword(operator, returned.receipt)
      break
  }
  return returned
}

async function verify(iam: Iam, record: Pending): Promise<Result> {
  const approval = record.approval
  const policy = record.foundation
  if (!approval || !policy) {
    return invalid()
  }
  const operator = operatorBinding(record)
  if (record.kind === 'onboard') {
    if (!record.password) {
      return invalid()
    }
    await iam.verifyOnboarding(operator, approval.inspection.signIn, policy, record.password)
  } else if (record.mutation !== null) {
    const expected = foundationChange(record)
    if (expected.action === 'create') {
      return invalid()
    }
    await iam.verifyFoundationChange(operator, expected)
  } else {
    const before = approval.inspection.before
    if (!before?.prior.policy) {
      return invalid()
    }
    const actual = await iam.inspectFoundation(operator, before.prior.policy)
    if (!sameJson(actual, before)) {
      return invalid()
    }
  }
  if (policy.document !== approval.permission.document || policy.sha256 !== approval.permission.sha256) {
    return invalid()
  }
  return {
    kind: 'verified',
    policy,
  }
}

export async function execute(request: Request): Promise<Result> {
  // Leave time for classification and IPC transmission before the parent's
  // independent credential-process deadline.
  const signal = AbortSignal.timeout(AWS_SPEC.iam.requestTimeoutMs - 5_000)
  const { record, connection } = await childContext()
  authorize(record, request)
  const resolved = await credentials(record.region)
  const sts = new STSClient({
    ...configuration(record.region),
    credentials: resolved,
  })
  const client = new IAMClient({
    ...configuration(record.region),
    credentials: resolved,
  })
  try {
    const response = await sts.send(new GetCallerIdentityCommand({}), {
      abortSignal: AbortSignal.any([signal, AbortSignal.timeout(AWS_SPEC.requestTimeoutMs)]),
    })
    const identity = rootIdentity({
      accountId: response.Account,
      arn: response.Arn,
      userId: response.UserId,
    })
    if (record.accountId !== null && record.accountId !== identity.accountId) {
      throw new InstallerError({
        code: 'AWS_IDENTITY_MISMATCH',
      })
    }
    const iam = new Iam(client, signal)
    const mfaConfigured = await iam.mfa()
    if (request.kind === 'inspect') {
      return await inspect(iam, record, connection, identity, expiresAt(resolved), mfaConfigured)
    }
    if (!mfaConfigured) {
      throw new InstallerError({
        code: 'AWS_ROOT_MFA_REQUIRED',
      })
    }
    switch (request.kind) {
      case 'mutate':
        return await mutate(iam, record, signal)
      case 'verify-mutation':
        return await verifyMutation(iam, record)
      case 'readiness': {
        const approval = record.approval
        if (!approval || !record.foundation || !record.password) {
          return invalid()
        }
        return {
          kind: 'readiness',
          readiness: await iam.readiness(
            operatorBinding(record),
            approval.inspection.signIn,
            record.foundation,
            record.password,
          ),
        }
      }
      case 'verify':
        return await verify(iam, record)
    }
  } finally {
    client.destroy()
    sts.destroy()
  }
}
