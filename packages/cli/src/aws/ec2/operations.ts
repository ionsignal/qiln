import { EC2Client } from '@aws-sdk/client-ec2'
import { findPin } from '../ami'
import { configuration } from '../auth/credentials'
import { sendEvidence } from '../child/evidence'
import { expectation, matches } from '../deployment/expect'
import { readPublicKey, type PublicKeyReader } from '../ssh/store'
import { Ec2 } from './client'
import { discover } from './discover'
import { armDispatch } from './dispatch'
import { observeHealth } from './health'
import { mutate } from './mutate'
import { candidates, observe } from './observe'
import { authorizeDeployment, authorizePreparation, notAttempted, type Credentials } from './context'
import {
  childDeadlineMs,
  isAcknowledgment,
  type DeploymentRequest,
  type Evidence,
  type Request,
  type Result,
} from './protocol'
import type { Deployment } from '../deployment/types'

function retain(evidence: Evidence, signal: AbortSignal): Promise<void> {
  return sendEvidence(
    evidence,
    message => isAcknowledgment(message, evidence),
    signal,
    'AWS_DEPLOYMENT_EVIDENCE_UNAVAILABLE',
  )
}

async function withEc2<T>(
  region: string,
  credentials: Credentials,
  signal: AbortSignal,
  use: (ec2: Ec2) => Promise<T>,
): Promise<T> {
  const client = new EC2Client({
    ...configuration(region),
    credentials,
  })
  try {
    // One application-level send() is one provider attempt only if the SDK does
    // not retry, so the effective configuration is asserted before any call.
    if ((await client.config.maxAttempts()) !== 1) {
      return notAttempted()
    }
    return await use(new Ec2(client, signal))
  } finally {
    client.destroy()
  }
}

async function run(
  ec2: Ec2,
  record: Deployment,
  request: DeploymentRequest,
  readKey: PublicKeyReader,
  signal: AbortSignal,
): Promise<Result> {
  switch (request.kind) {
    case 'mutate': {
      const step = record.steps.at(-1)
      if (step === undefined) {
        return notAttempted()
      }
      // One non-polled read must agree with the ledger before anything changes.
      if (!matches(expectation(record), await observe(ec2, record, false))) {
        return notAttempted()
      }
      const resourceId = await mutate(ec2, record, step, readKey)
      await retain(
        {
          kind: 'step-returned',
          deploymentId: record.id,
          operationId: step.id,
          resourceId,
          returnedAt: new Date().toISOString(),
        },
        signal,
      )
      return {
        kind: 'done',
        resourceId,
      }
    }
    case 'observe':
      return {
        kind: 'observation',
        observation: await observe(ec2, record, request.wait),
      }
    case 'candidates':
      return {
        kind: 'candidates',
        candidates: await candidates(ec2, record),
      }
    case 'health':
      return {
        kind: 'health',
        health: await observeHealth(ec2, record, request.wait),
      }
  }
}

export async function execute(request: Request): Promise<Result> {
  // Only a mutating request can dispatch, so only it may have earlier
  // failures reclassified as not attempted.
  if (request.kind === 'mutate') {
    armDispatch()
  }
  const signal = AbortSignal.timeout(childDeadlineMs(request))
  if (request.kind === 'prepare') {
    const { region, credentials } = await authorizePreparation(signal)
    const pin = findPin(region) ?? notAttempted()
    return await withEc2(
      region,
      credentials,
      signal,
      async (ec2): Promise<Result> => ({ kind: 'prepared', discovery: await discover(ec2, pin) }),
    )
  }
  const { root, record, region, credentials } = await authorizeDeployment(request, signal)
  // Only import dispatch reads the local public key, and only against the recorded binding.
  const readKey: PublicKeyReader = () => readPublicKey(root, record)
  return await withEc2(region, credentials, signal, ec2 => run(ec2, record, request, readKey, signal))
}
