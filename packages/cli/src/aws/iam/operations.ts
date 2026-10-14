import { IAMClient } from '@aws-sdk/client-iam'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { InstallerError } from '../../diagnostic/error'
import { configuration, credentials, expiresAt } from '../auth/credentials'
import { POLICY_KEYS, policyMap, type PolicyKey } from '../permission/keys'
import { isSpec } from '../permission/spec'
import { AWS_SPEC } from '../spec'
import type { AwsConnection } from '../types'
import { Iam } from './client'
import { childContext } from './journal'
import { retainPassword } from './password'
import type { Request, Result } from './protocol'
import { authorize, expectation, plan, position } from './transitions'
import {
  isRootIdentity,
  type Binding,
  type Mutation,
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

function policyKey(mutation: Mutation): PolicyKey {
  return mutation.key ?? invalid()
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
    await iam.policiesAbsent(intended)
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
  const bound = connection.managed.policies
  const before = await iam.inspect(operatorBinding(record), bound)
  // A bound policy that is detached is an inconsistency, not something to
  // silently approve and later report as verified. A key the connection has
  // not enrolled is already required to be absent from IAM by the inspection.
  if (POLICY_KEYS.some(key => bound[key] !== undefined && !before.policies[key].attached)) {
    throw new InstallerError({
      code: 'AWS_BOOTSTRAP_CONFLICT',
    })
  }
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
  const index = position(record)
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
    case 'create-policy': {
      const key = policyKey(mutation)
      return {
        kind: 'policy',
        action: 'create-policy',
        key,
        policy: await iam.createPolicy(operator, approval.permission, key, expectation(record, index)),
      }
    }
    case 'attach-policy': {
      const key = policyKey(mutation)
      return {
        kind: 'policy',
        action: 'attach-policy',
        key,
        policy: await iam.attachPolicy(operator, key, expectation(record, index)),
      }
    }
    case 'replace-policy': {
      const key = policyKey(mutation)
      return {
        kind: 'policy',
        action: 'replace-policy',
        key,
        policy: await iam.replacePolicy(operator, approval.permission, key, expectation(record, index)),
      }
    }
    case 'password':
      return {
        kind: 'password',
        receipt: await iam.password(operator, signIn, expectation(record, index).policies, receipt =>
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
  const index = position(record)
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
    case 'create-policy':
    case 'attach-policy':
    case 'replace-policy': {
      const key = policyKey(mutation)
      await iam.verifyPermissions(operator, expectation(record, index + 1), {
        key,
        before: expectation(record, index).policies[key],
      })
      break
    }
    case 'password':
      if (returned.kind !== 'password') {
        return invalid()
      }
      await iam.verifyPolicies(operator, signIn, expectation(record, index).policies)
      await iam.verifyPassword(operator, returned.receipt)
      break
  }
  return returned
}

async function verify(iam: Iam, record: Pending): Promise<Result> {
  if (!record.approval) {
    return invalid()
  }
  const operator = operatorBinding(record)
  const expected = expectation(record, plan(record).length)
  if (record.kind === 'onboard') {
    if (!record.password) {
      return invalid()
    }
    await iam.verifyOnboarding(operator, expected.signIn, expected.policies, record.password)
  } else {
    await iam.verifyPermissions(operator, expected, null)
  }
  return {
    kind: 'verified',
    policies: policyMap(key => expected.policies[key].policy ?? invalid()),
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
        if (!approval || !record.password) {
          return invalid()
        }
        return {
          kind: 'readiness',
          readiness: await iam.readiness(
            operatorBinding(record),
            approval.inspection.signIn,
            expectation(record, plan(record).length).policies,
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
