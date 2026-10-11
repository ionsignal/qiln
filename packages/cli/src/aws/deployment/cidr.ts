const PRIVATE_RANGES = [
  { base: 0x0a000000, prefix: 8 },
  { base: 0xac100000, prefix: 12 },
  { base: 0xc0a80000, prefix: 16 },
] as const

const CIDR_PATTERN = /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\/([1-9][0-9])$/

/**
 * Private-only networks are Qiln policy, not an AWS restriction. AWS would
 * canonicalize host bits, so they are rejected rather than normalized.
 */
export function validCidr(value: string): boolean {
  const match = CIDR_PATTERN.exec(value)
  if (!match) {
    return false
  }
  const octets = match.slice(1, 5).map(Number)
  const prefix = Number(match[5])
  if (octets.some(octet => octet > 255) || prefix < 16 || prefix > 28) {
    return false
  }
  const address = octets.reduce((total, octet) => total * 256 + octet, 0)
  const size = 2 ** (32 - prefix)
  if (address % size !== 0) {
    return false
  }
  return PRIVATE_RANGES.some(range => address >= range.base && address + size <= range.base + 2 ** (32 - range.prefix))
}
