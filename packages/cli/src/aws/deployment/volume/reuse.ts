import { phase } from '../observe/facts'
import { claimed, holdsVolume } from '../handoff/stage'
import { dataTags, dataVolumeId, hostSlotOf } from '../topology'
import type { Placement, Tag } from '../layout'
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
 * Local eligibility only: the volume is recorded and held by this record,
 * either created by it or attached by it, then retained after a verified
 * removal, or kept after an abandoned reservation, and no later deployment has
 * reserved or taken it. A reuse replacement that never attached the volume
 * only reserved it, so it is not offered until it abandons the reservation. A
 * fresh AWS read must still agree before reuse is offered for approval.
 */
export function reusable(record: Deployment): Reuse | null {
  const volumeId = dataVolumeId(record)
  const current = phase(record)
  if (
    volumeId === null ||
    claimed(record) ||
    !holdsVolume(record) ||
    (current !== 'retained' && current !== 'abandoned')
  ) {
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
