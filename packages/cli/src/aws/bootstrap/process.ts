import { IAMClient } from '@aws-sdk/client-iam'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { InstallerError } from '../../diagnostic/error'
import { configuration, credentials, expiresAt } from '../auth/credentials'
import { classify } from '../errors'
import { AWS_SPEC } from '../spec'
import { Iam } from './iam'
import { context } from './state'
import {
  isBootstrapRequest,
  isRootIdentity,
  type BootstrapAction,
  type BootstrapRecord,
  type BootstrapReply,
  type BootstrapRequest,
  type BootstrapResult,
  type RootIdentity,
} from './types'

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

function authorize(request: BootstrapRequest, record: BootstrapRecord): void {
  const phases: Record<BootstrapAction, readonly string[]> = {
    inspect: ['login', 'inspected'],
    create: ['creating'],
    attach: ['attaching'],
    grant: ['granting'],
    password: ['password'],
    readiness: ['handoff', 'ready'],
  }
  if (
    request.operationId !== record.id ||
    request.region !== record.region ||
    record.failureCode !== null ||
    record.termination !== 'unconfirmed' ||
    record.cleanup !== 'pending' ||
    !phases[request.kind].includes(record.phase) ||
    (request.kind !== 'inspect' && (!record.root?.mfaConfigured || !record.approvedAt || !record.review))
  ) {
    throw new InstallerError({
      code: 'AWS_BOOTSTRAP_STATE_INVALID',
    })
  }
}

async function execute(request: BootstrapRequest): Promise<BootstrapResult> {
  // Leave time for the child to classify an aborted request and transmit its
  // reply before the parent's independent execution deadline.
  const signal = AbortSignal.timeout(AWS_SPEC.bootstrap.requestTimeoutMs - 5_000)
  const { record } = await context()
  authorize(request, record)
  const resolved = await credentials(request.region)
  const sts = new STSClient({
    ...configuration(request.region),
    credentials: resolved,
  })
  const client = new IAMClient({
    ...configuration(request.region),
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
    const expiration = expiresAt(resolved)
    if (
      record.root &&
      (identity.accountId !== record.root.identity.accountId || identity.arn !== record.root.identity.arn)
    ) {
      throw new InstallerError({
        code: 'AWS_IDENTITY_MISMATCH',
      })
    }
    const iam = new Iam(client, signal)
    const mfaConfigured = await iam.mfa()
    if (request.kind === 'inspect') {
      const root = {
        identity,
        expiresAt: expiration,
        mfaConfigured,
      }
      await iam.absent({
        ...record,
        root,
      })
      return {
        kind: 'inspection',
        root,
        review: await iam.review(),
      }
    }
    if (!mfaConfigured) {
      throw new InstallerError({
        code: 'AWS_ROOT_MFA_REQUIRED',
      })
    }
    switch (request.kind) {
      case 'create':
        return {
          kind: 'operator',
          identity: await iam.create(record),
        }
      case 'attach':
        await iam.attach(record)
        return {
          kind: 'done',
          action: 'attach',
        }
      case 'grant':
        await iam.grant(record)
        return {
          kind: 'done',
          action: 'grant',
        }
      case 'password':
        await iam.password(record)
        return {
          kind: 'done',
          action: 'password',
        }
      case 'readiness':
        return {
          kind: 'readiness',
          readiness: await iam.readiness(record),
        }
    }
  } finally {
    client.destroy()
    sts.destroy()
  }
}

function reply(message: BootstrapReply): void {
  if (!process.send || !process.connected) {
    process.exit(1)
  }
  process.send(message, error => {
    process.exit(error ? 1 : 0)
  })
}

async function handle(message: unknown): Promise<void> {
  if (!isBootstrapRequest(message)) {
    reply({
      ok: false,
      code: 'AWS_BOOTSTRAP_STATE_INVALID',
    })
    return
  }
  try {
    reply({
      ok: true,
      result: await execute(message),
    })
  } catch (error: unknown) {
    reply({
      ok: false,
      code: classify(error),
    })
  }
}

if (!process.send) {
  process.exitCode = 1
} else {
  process.umask(0o077)
  process.once('disconnect', () => process.exit(1))
  process.once('message', (message: unknown) => {
    void handle(message)
  })
}
