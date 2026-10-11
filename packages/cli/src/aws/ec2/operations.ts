import { EC2Client } from '@aws-sdk/client-ec2'
import { configuration } from '../auth/credentials'
import { sendEvidence } from '../child/evidence'
import { sameJson } from '../json'
import { AWS_SPEC } from '../spec'
import { Ec2 } from './client'
import { authorize, notAttempted } from './context'
import { isAcknowledgment, type Evidence, type Request, type Result } from './protocol'

/** The reply is withheld until the parent confirms that the returned evidence was retained. */
function retain(evidence: Evidence, signal: AbortSignal): Promise<void> {
  return sendEvidence(
    evidence,
    message => isAcknowledgment(message, evidence),
    signal,
    'AWS_DEPLOYMENT_EVIDENCE_UNAVAILABLE',
  )
}

export async function execute(request: Request): Promise<Result> {
  // Leave time for classification and IPC transmission before the parent's
  // independent credential-process deadline.
  const signal = AbortSignal.timeout(AWS_SPEC.deployment.requestTimeoutMs - 5_000)
  const { record, credentials } = await authorize(request, signal)
  const client = new EC2Client({
    ...configuration(record.binding.region),
    credentials,
  })
  try {
    const ec2 = new Ec2(client, signal)
    switch (request.kind) {
      case 'create': {
        const vpcId = await ec2.create(record)
        await retain(
          {
            kind: 'vpc-created',
            deploymentId: record.id,
            operationId: request.operationId,
            vpcId,
            returnedAt: new Date().toISOString(),
          },
          signal,
        )
        return {
          kind: 'created',
          vpcId,
        }
      }
      case 'delete': {
        const approved = record.removals.at(-1)?.approval.observation
        if (!approved) {
          return notAttempted()
        }
        // Reads precede the single mutating call. The approval covers the VPC
        // that was observed, so only its timestamp may differ.
        const current = await ec2.observe(approved.vpcId, 'any')
        if (!sameJson(current.vpc, approved.vpc)) {
          return notAttempted()
        }
        await ec2.delete(approved.vpcId)
        await retain(
          {
            kind: 'vpc-deleted',
            deploymentId: record.id,
            operationId: request.operationId,
            returnedAt: new Date().toISOString(),
          },
          signal,
        )
        return {
          kind: 'deleted',
        }
      }
      case 'observe': {
        const vpcId = record.creation?.returned?.vpcId
        if (vpcId === undefined) {
          return notAttempted()
        }
        return {
          kind: 'observation',
          observation: await ec2.observe(vpcId, request.until),
        }
      }
      case 'candidates':
        return {
          kind: 'candidates',
          candidates: await ec2.candidates(record),
        }
    }
  } finally {
    client.destroy()
  }
}
