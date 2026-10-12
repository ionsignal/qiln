import { EC2Client } from '@aws-sdk/client-ec2'
import { configuration } from '../auth/credentials'
import { sendEvidence } from '../child/evidence'
import { expectation, matches } from '../deployment/topology'
import type { Deployment } from '../deployment/types'
import { AWS_SPEC } from '../spec'
import { Ec2 } from './client'
import { authorizeDeployment, authorizePlacement, notAttempted, type Credentials } from './context'
import { armDispatch } from './dispatch'
import { mutate } from './mutate'
import { candidates, observe } from './observe'
import { isAcknowledgment, type DeploymentRequest, type Evidence, type Request, type Result } from './protocol'

/** The reply is withheld until the parent confirms that the returned evidence was retained. */
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

async function run(ec2: Ec2, record: Deployment, request: DeploymentRequest, signal: AbortSignal): Promise<Result> {
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
      const resourceId = await mutate(ec2, record, step)
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
  }
}

export async function execute(request: Request): Promise<Result> {
  // Only a mutating request can dispatch, so only it may have earlier
  // failures reclassified as not attempted.
  if (request.kind === 'mutate') {
    armDispatch()
  }
  // Leave time for classification and IPC transmission before the parent's
  // independent credential-process deadline.
  const signal = AbortSignal.timeout(AWS_SPEC.deployment.requestTimeoutMs - 5_000)
  if (request.kind === 'placement') {
    const { region, credentials } = await authorizePlacement(signal)
    return await withEc2(region, credentials, signal, async ec2 => ({
      kind: 'zones',
      zones: await ec2.zones(),
    }))
  }
  const { record, region, credentials } = await authorizeDeployment(request, signal)
  return await withEc2(region, credentials, signal, ec2 => run(ec2, record, request, signal))
}
