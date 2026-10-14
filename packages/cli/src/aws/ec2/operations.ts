import { EC2Client } from '@aws-sdk/client-ec2'
import { AWS_SPEC } from '../spec'
import { findPin } from '../ami'
import { configuration } from '../auth/credentials'
import { sendEvidence } from '../child/evidence'
import { expectation, matches } from '../deployment/expect'
import { Ec2 } from './client'
import { discover } from './discover'
import { armDispatch } from './dispatch'
import { keyReader, type KeyReader } from './key'
import { mutate } from './mutate'
import { candidates, observe } from './observe'
import { authorizeDeployment, authorizePreparation, notAttempted, type Credentials } from './context'
import { isAcknowledgment, type DeploymentRequest, type Evidence, type Request, type Result } from './protocol'
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
    return await use(new Ec2(client, signal))
  } finally {
    client.destroy()
  }
}

async function run(
  ec2: Ec2,
  record: Deployment,
  request: DeploymentRequest,
  readKey: KeyReader,
  signal: AbortSignal,
): Promise<Result> {
  switch (request.kind) {
    case 'mutate': {
      const step = record.steps.at(-1)
      if (step === undefined) {
        return notAttempted()
      }
      // One non-polled read must agree with the ledger before anything changes.
      if (!matches(expectation(record), await observe(ec2, record, false, readKey))) {
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
        observation: await observe(ec2, record, request.wait, readKey),
      }
    case 'candidates':
      return {
        kind: 'candidates',
        candidates: await candidates(ec2, record),
      }
  }
}

export async function execute(request: Request): Promise<Result> {
  // Only a mutating request can dispatch, so only it may have earlier
  // failures reclassified as not attempted.
  if (request.kind === 'mutate') {
    armDispatch()
  }
  const signal = AbortSignal.timeout(AWS_SPEC.deployment.requestTimeoutMs - 5_000)
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
  const readKey = keyReader(root, record.id)
  return await withEc2(region, credentials, signal, ec2 => run(ec2, record, request, readKey, signal))
}
