import { InstallerError } from '../diagnostic/error'
import { assertNetwork } from '../install/network'
import { runProcess } from '../process'
import { toInstallerError } from '../incus/errors'
import type { Layout } from '../install/layout'
import type { IncusClient } from '../incus/client'
import type { IncusNetwork } from '../incus/types'
import type { HostPreflight } from './host'

interface IPv4Cidr {
  address: bigint
  network: bigint
  prefixLength: number
}

interface IpRouteRecord {
  dst?: unknown
  dev?: unknown
}

interface IpAddressRecord {
  ifname?: unknown
  addr_info?: unknown
}

export interface NetworkPreflight {
  network: IncusNetwork | null
  disposition: 'existing-compatible' | 'ready-to-create'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ipv4AddressToBigInt(value: string): bigint | null {
  const octets = value.split('.')
  if (octets.length !== 4) {
    return null
  }
  let result = 0n
  for (const octet of octets) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(octet)) {
      return null
    }
    const parsed = Number(octet)
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 255) {
      return null
    }
    result = (result << 8n) | BigInt(parsed)
  }
  return result
}

function parseIpv4Cidr(value: string): IPv4Cidr | null {
  const [addressValue, prefixValue, extra] = value.split('/')
  if (extra !== undefined || addressValue === undefined) {
    return null
  }
  const address = ipv4AddressToBigInt(addressValue)
  const prefixLength = prefixValue === undefined ? 32 : Number(prefixValue)
  if (address === null || !Number.isSafeInteger(prefixLength) || prefixLength < 0 || prefixLength > 32) {
    return null
  }
  const allBits = (1n << 32n) - 1n
  const hostBits = 32 - prefixLength
  const mask = hostBits === 32 ? 0n : allBits ^ ((1n << BigInt(hostBits)) - 1n)
  return {
    address,
    network: address & mask,
    prefixLength,
  }
}

function cidrsOverlap(left: IPv4Cidr, right: IPv4Cidr): boolean {
  const leftSize = 1n << BigInt(32 - left.prefixLength)
  const rightSize = 1n << BigInt(32 - right.prefixLength)
  const leftEnd = left.network + leftSize - 1n
  const rightEnd = right.network + rightSize - 1n
  return left.network <= rightEnd && right.network <= leftEnd
}

function parseJsonArray(value: string, source: string): unknown[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    throw new InstallerError({
      code: 'HOST_NETWORK_INSPECTION_FAILED',
      facts: [['Observed', `${source} returned invalid JSON.`]],
      retry: 'qiln doctor',
    })
  }
  if (!Array.isArray(parsed)) {
    throw new InstallerError({
      code: 'HOST_NETWORK_INSPECTION_FAILED',
      facts: [['Observed', `${source} did not return a JSON array.`]],
      retry: 'qiln doctor',
    })
  }
  return parsed
}

function assertNoIncusNetworkConflict(
  networks: readonly IncusNetwork[],
  existingTargetNetwork: IncusNetwork | null,
  layout: Layout,
): void {
  const { name, ipv4Subnet } = layout.network
  const target = parseIpv4Cidr(ipv4Subnet)!
  for (const network of networks) {
    if (network.name === name && existingTargetNetwork !== null) {
      continue
    }
    const configuredAddress = network.config['ipv4.address']
    if (!configuredAddress || configuredAddress === 'none' || configuredAddress === 'auto') {
      continue
    }
    const candidate = parseIpv4Cidr(configuredAddress)
    if (candidate && cidrsOverlap(target, candidate)) {
      throw new InstallerError({
        code: 'INCUS_NETWORK_RANGE_CONFLICT',
        facts: [
          ['Observed', `Network '${network.name}' uses '${configuredAddress}', which overlaps '${ipv4Subnet}'.`],
        ],
        retry: 'qiln doctor',
      })
    }
  }
}

async function assertNoHostRouteConflict(
  host: HostPreflight,
  existingTargetNetwork: IncusNetwork | null,
  layout: Layout,
): Promise<void> {
  const { name, ipv4Subnet } = layout.network
  const target = parseIpv4Cidr(ipv4Subnet)!
  const routeResult = await runProcess(host.commandPaths.ip, ['-j', '-4', 'route', 'show', 'table', 'all'])
  if (routeResult.exitCode !== 0) {
    throw new InstallerError({
      code: 'HOST_ROUTE_INSPECTION_FAILED',
      facts: [['Observed', `ip returned exit code ${routeResult.exitCode ?? 'unknown'}.`]],
      retry: 'qiln doctor',
    })
  }
  for (const rawRoute of parseJsonArray(routeResult.stdout, 'ip route')) {
    if (!isRecord(rawRoute)) {
      continue
    }
    const route = rawRoute as IpRouteRecord
    if (typeof route.dst !== 'string' || route.dst === 'default') {
      continue
    }
    const routeCidr = parseIpv4Cidr(route.dst)
    if (!routeCidr || !cidrsOverlap(target, routeCidr)) {
      continue
    }
    const device = typeof route.dev === 'string' ? route.dev : ''
    if (existingTargetNetwork !== null && device === name) {
      continue
    }
    throw new InstallerError({
      code: 'HOST_ROUTE_RANGE_CONFLICT',
      facts: [
        [
          'Observed',
          `Host route '${route.dst}' on interface '${device || 'unknown'}' overlaps '${ipv4Subnet}'.`,
        ],
      ],
      retry: 'qiln doctor',
    })
  }
  const addressResult = await runProcess(host.commandPaths.ip, ['-j', '-4', 'address', 'show'])
  if (addressResult.exitCode !== 0) {
    throw new InstallerError({
      code: 'HOST_ADDRESS_INSPECTION_FAILED',
      facts: [['Observed', `ip returned exit code ${addressResult.exitCode ?? 'unknown'}.`]],
      retry: 'qiln doctor',
    })
  }
  for (const rawInterface of parseJsonArray(addressResult.stdout, 'ip address')) {
    if (!isRecord(rawInterface)) {
      continue
    }
    const networkInterface = rawInterface as IpAddressRecord
    const interfaceName = typeof networkInterface.ifname === 'string' ? networkInterface.ifname : ''
    if (!Array.isArray(networkInterface.addr_info)) {
      continue
    }
    for (const rawAddress of networkInterface.addr_info) {
      if (!isRecord(rawAddress)) {
        continue
      }
      const local = rawAddress.local
      const prefixLength = rawAddress.prefixlen
      if (typeof local !== 'string' || typeof prefixLength !== 'number') {
        continue
      }
      const addressCidr = parseIpv4Cidr(`${local}/${prefixLength}`)
      if (!addressCidr || !cidrsOverlap(target, addressCidr)) {
        continue
      }
      if (existingTargetNetwork !== null && interfaceName === name) {
        continue
      }
      throw new InstallerError({
        code: 'HOST_ADDRESS_RANGE_CONFLICT',
        facts: [
          [
            'Observed',
            `Interface '${interfaceName || 'unknown'}' has '${local}/${prefixLength}', overlapping '${ipv4Subnet}'.`,
          ],
        ],
        retry: 'qiln doctor',
      })
    }
  }
}

export async function validateNetworkPreflight(
  host: HostPreflight,
  client: IncusClient,
  layout: Layout,
): Promise<NetworkPreflight> {
  const { name } = layout.network
  let networks: IncusNetwork[]
  try {
    networks = await client.getNetworks()
  } catch (error: unknown) {
    throw toInstallerError(error, {
      check: 'local Incus network inventory',
      operation: 'list local Incus networks',
      rerun: 'qiln doctor',
    })
  }
  let existingTargetNetwork: IncusNetwork | null
  try {
    existingTargetNetwork =
      networks.find(network => network.name === name) ?? (await client.getNetworkOrNull(name))
  } catch (error: unknown) {
    throw toInstallerError(error, {
      check: `existing ${name} inspection`,
      operation: `inspect the '${name}' network`,
      rerun: 'qiln doctor',
    })
  }
  if (existingTargetNetwork) {
    assertNetwork(existingTargetNetwork, layout)
  }
  assertNoIncusNetworkConflict(networks, existingTargetNetwork, layout)
  await assertNoHostRouteConflict(host, existingTargetNetwork, layout)
  return {
    network: existingTargetNetwork,
    disposition: existingTargetNetwork ? 'existing-compatible' : 'ready-to-create',
  }
}
