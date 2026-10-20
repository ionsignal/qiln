import { AWS_SPEC } from '../spec'
import { InstallerError } from '../../diagnostic/error'
import { bootstrapOf } from '../deployment/host/bootstrap'

const { compute, permission } = AWS_SPEC

/**
 * EC2 accepts at most 16 KiB of raw user-data before base64 encoding.
 */
const USER_DATA_LIMIT_BYTES = 16 * 1_024

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
 * The frozen bootstrap is a cloud-config document of printable ASCII and
 * newlines that fits the raw user-data limit.
 */
function bootstrapLegal(): boolean {
  const { cloudConfig } = bootstrapOf()
  return (
    Buffer.byteLength(cloudConfig, 'utf8') <= USER_DATA_LIMIT_BYTES &&
    cloudConfig.startsWith('#cloud-config\n') &&
    /^[\x20-\x7e\n]+$/.test(cloudConfig)
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
    ) &&
    bootstrapLegal()
  if (!valid) {
    throw new InstallerError({
      code: 'INTERNAL_ERROR',
    })
  }
}
