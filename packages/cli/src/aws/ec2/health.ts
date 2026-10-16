
import { DescribeInstanceStatusCommand } from '@aws-sdk/client-ec2'
import { AWS_SPEC } from '../spec'
import { resourceId } from '../deployment/topology'
import { isRecord } from '../guards'
import { poll } from '../observe'
import { unverified } from './observe/shared'
import type { Ec2 } from './client'
import type { Deployment, Health } from '../deployment/types'

const HEALTH = {
  ...AWS_SPEC.deployment.health.observation,
  code: 'AWS_DEPLOYMENT_HEALTH_UNVERIFIED',
} as const

/**
 * Immediately after launch the instance may not be listed yet, which is not a
 * failure of the health read, so it is polled through like any other wait.
 */
function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.name === 'InvalidInstanceID.NotFound'
}

/**
 * One read. Only an entry matched by instance ID that is running with all
 * three statuses explicitly `ok` passes. Missing, initializing,
 * insufficient-data, impaired, and not-applicable results are not passing
 * evidence. `MaxResults` is never combined with explicit IDs, so a
 * continuation token is itself unusable.
 */
async function read(ec2: Ec2, instanceId: string, signal?: AbortSignal): Promise<Health | null> {
  let response
  try {
    response = await ec2.read(
      (client, call) =>
        client.send(new DescribeInstanceStatusCommand({ InstanceIds: [instanceId], IncludeAllInstances: true }), call),
      signal,
    )
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return null
    }
    throw error
  }
  if (response.NextToken !== undefined) {
    return unverified()
  }
  const matched = (response.InstanceStatuses ?? []).filter(status => status.InstanceId === instanceId)
  if (matched.length !== 1) {
    return null
  }
  const [status] = matched
  if (
    status.InstanceState?.Name !== 'running' ||
    status.SystemStatus?.Status !== 'ok' ||
    status.InstanceStatus?.Status !== 'ok' ||
    status.AttachedEbsStatus?.Status !== 'ok'
  ) {
    return null
  }
  return {
    instanceId,
    checkedAt: new Date().toISOString(),
    instanceState: 'running',
    system: 'ok',
    instance: 'ok',
    attachedEbs: 'ok',
  }
}

/**
 * Reads the recorded instance's AWS health. With `wait` it polls within its
 * budget and an exhausted budget is an error that does not prove the instance
 * unhealthy; without it, a non-passing read returns null. It never mutates.
 */
export async function observeHealth(ec2: Ec2, record: Deployment, wait: boolean): Promise<Health | null> {
  const instanceId = resourceId(record, 'run-instances') ?? unverified()
  if (!wait) {
    return await read(ec2, instanceId)
  }
  const seen: { latest: Health | null } = {
    latest: null,
  }
  await poll(async signal => {
    seen.latest = await read(ec2, instanceId, signal)
    return seen.latest !== null
  }, HEALTH)
  return seen.latest
}
