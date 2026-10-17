import { AWS_SPEC } from '../spec'
import { InstallerError } from '../../diagnostic/error'

const { compute, permission } = AWS_SPEC

/**
 * gp3 rules: at least 1 GiB, a 3,000 IOPS and 125 MiB/s baseline, IOPS of at
 * most 500 per GiB above that baseline, and throughput of at most 0.25 MiB/s
 * per IOPS. They are applied to every permitted type, which is gp3 only.
 */
function gp3Legal(sizeGiB: number, iops: number, throughput: number): boolean {
  return (
    Number.isSafeInteger(sizeGiB) &&
    Number.isSafeInteger(iops) &&
    Number.isSafeInteger(throughput) &&
    sizeGiB >= 1 &&
    iops >= 3_000 &&
    iops <= Math.max(3_000, 500 * sizeGiB) &&
    throughput >= 125 &&
    throughput <= iops / 4
  )
}

/**
 * Local check of the deployment defaults against the permission envelope. The
 * frozen plan is derived only from these constants, so checking them rejects an
 * unsupported launch before any prompt, authentication, or AWS call. It is a
 * maintainer-error guard, not a quota check, and no operator input reaches it.
 */
export function requireEnvelope(): void {
  const { defaultInstanceType, storage } = compute
  const { volumes } = permission
  const catalog: readonly string[] = permission.instanceTypes
  const types: readonly string[] = volumes.types
  const sizes = [
    { sizeGiB: storage.rootSizeGiB, maximumGiB: volumes.maximumRootGiB },
    { sizeGiB: storage.dataSizeGiB, maximumGiB: volumes.maximumDataGiB },
  ]
  const valid =
    catalog.includes(defaultInstanceType) &&
    types.includes(storage.volumeType) &&
    storage.iops <= volumes.maximumIops &&
    storage.throughput <= volumes.maximumThroughput &&
    sizes.every(
      ({ sizeGiB, maximumGiB }) =>
        sizeGiB <= maximumGiB && gp3Legal(sizeGiB, storage.iops, storage.throughput),
    )
  if (!valid) {
    throw new InstallerError({
      code: 'INTERNAL_ERROR',
    })
  }
}
