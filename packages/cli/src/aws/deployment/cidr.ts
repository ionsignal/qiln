import { AWS_SPEC } from '../spec'

const PRIVATE_RANGES = [
  { base: 0x0a000000, prefix: 8 },
  { base: 0xac100000, prefix: 12 },
  { base: 0xc0a80000, prefix: 16 },
] as const

const ADDRESS = '(0|[1-9][0-9]{0,2})\\.(0|[1-9][0-9]{0,2})\\.(0|[1-9][0-9]{0,2})\\.(0|[1-9][0-9]{0,2})'
const CIDR_PATTERN = new RegExp(`^${ADDRESS}/([1-9][0-9])$`)
const SOURCE_PATTERN = new RegExp(`^${ADDRESS}/([1-9]|[12][0-9]|3[0-2])$`)

function parse(pattern: RegExp, value: string): { address: number; prefix: number } | null {
  const match = pattern.exec(value)
  if (!match) {
    return null
  }
  const octets = match.slice(1, 5).map(Number)
  const prefix = Number(match[5])
  if (octets.some(octet => octet > 255)) {
    return null
  }
  const address = octets.reduce((total, octet) => total * 256 + octet, 0)
  return address % 2 ** (32 - prefix) === 0 ? { address, prefix } : null
}

export function validCidr(value: string): boolean {
  const network = parse(CIDR_PATTERN, value)
  if (!network || network.prefix < 16 || network.prefix > 28) {
    return false
  }
  const size = 2 ** (32 - network.prefix)
  return PRIVATE_RANGES.some(
    range => network.address >= range.base && network.address + size <= range.base + 2 ** (32 - range.prefix),
  )
}

export function validSource(value: string): boolean {
  return parse(SOURCE_PATTERN, value) !== null
}

export function subnetCidr(vpc: string, index: number): string {
  const prefix = AWS_SPEC.deployment.subnetPrefix
  const address =
    vpc
      .slice(0, vpc.indexOf('/'))
      .split('.')
      .reduce((total, octet) => total * 256 + Number(octet), 0) +
    index * 2 ** (32 - prefix)
  const octets = [24, 16, 8, 0].map(shift => Math.floor(address / 2 ** shift) % 256)
  return `${octets.join('.')}/${prefix}`
}

/**
 * Whether a canonical subnet lies inside its VPC network. This is a format
 * rule that does not read the subnet prefix policy, so a stored record keeps
 * its meaning if that policy changes. /28 is the smallest subnet AWS allows.
 */
export function contains(vpc: string, subnet: string): boolean {
  const outer = parse(CIDR_PATTERN, vpc)
  const inner = parse(CIDR_PATTERN, subnet)
  if (!outer || !inner || inner.prefix < outer.prefix || inner.prefix > 28) {
    return false
  }
  const size = 2 ** (32 - outer.prefix)
  return Math.floor(inner.address / size) === Math.floor(outer.address / size)
}
