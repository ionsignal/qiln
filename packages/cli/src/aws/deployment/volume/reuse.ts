import { phase } from '../observe/facts'
import type { Placement, Tag } from '../layout'
import { dataTags, dataVolumeId, hostSlotOf } from '../topology'
import type { DataVolume } from '../host/types'
import type { Deployment } from '../types'

/**
 * What a later deployment would inherit from a previous one: the retained data
 * volume by identity, its original tags, the zone that fixes its placement, and
 * the settings it was created with. Derived from one record, never from AWS
 * tags or an operator-supplied volume ID.
 */
export interface Reuse {
  volumeId: string
  from: string
  zone: Placement
  tags: Tag[]
  data: DataVolume
}

/**
 * Local eligibility only: removal was verified, the data volume is recorded and
 * still retained, and no later deployment has taken it over. A fresh AWS read
 * must still agree before reuse is offered for approval.
 */
export function reusable(record: Deployment): Reuse | null {
  const volumeId = dataVolumeId(record)
  if (volumeId === null || record.handoff !== null || phase(record) !== 'retained') {
    return null
  }
  const { plan } = record.approval.host
  const { id, name } = plan.zones[hostSlotOf(record)]
  return {
    from: record.id,
    volumeId,
    tags: structuredClone(dataTags(record)),
    zone: { id, name },
    data: structuredClone(plan.data),
  }
}
