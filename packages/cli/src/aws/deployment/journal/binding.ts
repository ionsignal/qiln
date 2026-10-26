import { z } from 'zod'
import { isIdentity, validName, validRegion, type AwsIdentity } from '../../types'
import { KIND_IDS } from '../graph'
import { dataVolumeId, resourceId } from '../topology'
import { operationId } from '../../../journal/step'
import type { Deployment } from '../types'

export const volumeId = z.string().regex(KIND_IDS.volume)

/**
 * The deployment this evidence belongs to. It is compared with the deployment
 * record on every read, so evidence can never be applied to another host.
 */
export const bindingSchema = z.strictObject({
  deployment: operationId,
  connection: z.string().refine(validName, 'Expected a connection name.'),
  operator: z.custom<AwsIdentity>(isIdentity),
  region: z.string().refine(validRegion, 'Expected a region.'),
  instanceId: z.string().regex(KIND_IDS.instance),
  rootVolumeId: volumeId,
  dataVolumeId: volumeId,
})

export type Binding = z.infer<typeof bindingSchema>

export interface HostIdentity {
  instanceId: string
  rootVolumeId: string
  dataVolumeId: string
}

/**
 * The recorded host identities, derived from the protected deployment record
 * alone. Null means the record lacks an identity, which callers treat as a
 * defect.
 */
export function identityOf(deployment: Deployment): HostIdentity | null {
  const instanceId = resourceId(deployment, 'run-instances')
  const dataId = dataVolumeId(deployment)
  const rootVolumeId = deployment.implicit?.rootVolumeId
  if (instanceId === null || dataId === null || rootVolumeId === undefined) {
    return null
  }
  return { instanceId, rootVolumeId, dataVolumeId: dataId }
}

export function bindingOf(deployment: Deployment): Binding | null {
  const identity = identityOf(deployment)
  if (identity === null) {
    return null
  }
  return {
    deployment: deployment.id,
    connection: deployment.connection,
    operator: deployment.binding.operator,
    region: deployment.binding.region,
    ...identity,
  }
}
