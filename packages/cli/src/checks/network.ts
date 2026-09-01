import { QilnInstallerError } from '../error'
import { INSTALLER_SPEC } from '../install/spec'
import { runProcess } from '../process'
import { toInstallerError } from '../incus/errors'
import type { LocalIncusClient } from '../incus/client'
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

function assertCompatibleNetwork(network: IncusNetwork): void {
  const expectedConfig = INSTALLER_SPEC.network.config
  const unexpectedConfigKeys = Object.keys(network.config).filter(
    key => !Object.hasOwn(expectedConfig, key) && !key.startsWith('volatile.'),
  )
  const mismatchedConfig = Object.entries(expectedConfig)
    .filter(([key, expectedValue]) => network.config[key] !== expectedValue)
    .map(([key, expectedValue]) => `${key} expected '${expectedValue}' but was '${network.config[key] ?? 'unset'}'`)
  const compatible =
    network.name === INSTALLER_SPEC.network.name &&
    network.type === INSTALLER_SPEC.network.type &&
    network.description === INSTALLER_SPEC.network.description &&
    network.managed &&
    network.status === 'Created' &&
    mismatchedConfig.length === 0 &&
    unexpectedConfigKeys.length === 0
  if (!compatible) {
    throw new QilnInstallerError({
      code: 'INCOMPATIBLE_INCUS_NETWORK',
      check: 'existing incusbr0 compatibility',
      summary: `The existing network '${INSTALLER_SPEC.network.name}' conflicts with the Qiln installer specification.`,
      observed: `Incus reports type='${network.type}', managed=${network.managed}, status='${network.status || 'unknown'}', description='${network.description}', ipv4.address='${network.config['ipv4.address'] ?? 'unset'}', ipv4.dhcp='${network.config['ipv4.dhcp'] ?? 'unset'}', ipv4.dhcp.ranges='${network.config['ipv4.dhcp.ranges'] ?? 'unset'}', ipv4.nat='${network.config['ipv4.nat'] ?? 'unset'}', ipv6.address='${network.config['ipv6.address'] ?? 'unset'}', and ipv6.nat='${network.config['ipv6.nat'] ?? 'unset'}'; missing or mismatched expected configuration: ${mismatchedConfig.join('; ') || 'none'}; unexpected non-volatile configuration keys: ${unexpectedConfigKeys.join(', ') || 'none'}.`,
      reason:
        'Qiln does not overwrite or partially repair an existing network with conflicting ownership or configuration.',
      operatorAction: `Inspect '${INSTALLER_SPEC.network.name}' manually. Preserve unrelated workloads and resolve the naming or address conflict outside Qiln.`,
      rerun: 'qiln doctor',
    })
  }
}

function parseJsonArray(value: string, source: string): unknown[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    throw new QilnInstallerError({
      code: 'HOST_NETWORK_INSPECTION_FAILED',
      check: 'host network routes and addresses',
      summary: 'The host IP configuration could not be decoded.',
      observed: `${source} returned invalid JSON.`,
      reason: 'Qiln cannot prove that 10.77.0.0/24 is free of host routing and address conflicts.',
      operatorAction: 'Inspect and repair the local iproute2 installation manually.',
      rerun: 'qiln doctor',
    })
  }
  if (!Array.isArray(parsed)) {
    throw new QilnInstallerError({
      code: 'HOST_NETWORK_INSPECTION_FAILED',
      check: 'host network routes and addresses',
      summary: 'The host IP configuration has an unexpected shape.',
      observed: `${source} did not return a JSON array.`,
      reason: 'Qiln cannot safely compare the planned development subnet against host networking.',
      operatorAction: 'Inspect and repair the local iproute2 installation manually.',
      rerun: 'qiln doctor',
    })
  }
  return parsed
}

async function assertNoIncusNetworkConflict(
  networks: readonly IncusNetwork[],
  existingTargetNetwork: IncusNetwork | null,
): Promise<void> {
  const target = parseIpv4Cidr(INSTALLER_SPEC.network.ipv4Subnet)!
  for (const network of networks) {
    if (network.name === INSTALLER_SPEC.network.name && existingTargetNetwork !== null) {
      continue
    }
    const configuredAddress = network.config['ipv4.address']
    if (!configuredAddress || configuredAddress === 'none' || configuredAddress === 'auto') {
      continue
    }
    const candidate = parseIpv4Cidr(configuredAddress)
    if (candidate && cidrsOverlap(target, candidate)) {
      throw new QilnInstallerError({
        code: 'INCUS_NETWORK_RANGE_CONFLICT',
        check: 'Incus network address ranges',
        summary: 'The planned Qiln IPv4 subnet overlaps another Incus network.',
        observed: `Network '${network.name}' uses '${configuredAddress}', which overlaps '${INSTALLER_SPEC.network.ipv4Subnet}'.`,
        reason: 'Creating the installer-owned bridge would introduce conflicting routing or address allocation.',
        operatorAction:
          'Move the unrelated Incus network to a non-overlapping range or choose a future explicitly configurable Qiln range. Qiln will not modify the network.',
        rerun: 'qiln doctor',
      })
    }
  }
}

async function assertNoHostRouteConflict(
  host: HostPreflight,
  existingTargetNetwork: IncusNetwork | null,
): Promise<void> {
  const target = parseIpv4Cidr(INSTALLER_SPEC.network.ipv4Subnet)!
  const routeResult = await runProcess(host.commandPaths.ip, ['-j', '-4', 'route', 'show', 'table', 'all'])
  if (routeResult.exitCode !== 0) {
    throw new QilnInstallerError({
      code: 'HOST_ROUTE_INSPECTION_FAILED',
      check: 'host IPv4 routes',
      summary: 'The host IPv4 routing table could not be inspected.',
      observed: `ip returned exit code ${routeResult.exitCode ?? 'unknown'}.`,
      reason: 'Qiln cannot prove that the planned 10.77.0.0/24 bridge range is conflict-free.',
      operatorAction: 'Inspect the host networking and iproute2 installation manually.',
      rerun: 'qiln doctor',
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
    if (existingTargetNetwork !== null && device === INSTALLER_SPEC.network.name) {
      continue
    }
    throw new QilnInstallerError({
      code: 'HOST_ROUTE_RANGE_CONFLICT',
      check: 'host IPv4 routes',
      summary: 'The planned Qiln IPv4 subnet overlaps an existing host route.',
      observed: `Host route '${route.dst}' on interface '${device || 'unknown'}' overlaps '${INSTALLER_SPEC.network.ipv4Subnet}'.`,
      reason: 'The installer-owned Incus bridge would conflict with existing host routing.',
      operatorAction:
        'Review the host route and network ownership manually. Qiln will not alter host routes or choose another range implicitly.',
      rerun: 'qiln doctor',
    })
  }
  const addressResult = await runProcess(host.commandPaths.ip, ['-j', '-4', 'address', 'show'])
  if (addressResult.exitCode !== 0) {
    throw new QilnInstallerError({
      code: 'HOST_ADDRESS_INSPECTION_FAILED',
      check: 'host IPv4 addresses',
      summary: 'The host IPv4 addresses could not be inspected.',
      observed: `ip returned exit code ${addressResult.exitCode ?? 'unknown'}.`,
      reason: 'Qiln cannot prove that the planned bridge gateway and subnet are conflict-free.',
      operatorAction: 'Inspect the host networking and iproute2 installation manually.',
      rerun: 'qiln doctor',
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
      if (existingTargetNetwork !== null && interfaceName === INSTALLER_SPEC.network.name) {
        continue
      }
      throw new QilnInstallerError({
        code: 'HOST_ADDRESS_RANGE_CONFLICT',
        check: 'host IPv4 addresses',
        summary: 'The planned Qiln IPv4 subnet overlaps an existing host address.',
        observed: `Interface '${interfaceName || 'unknown'}' has '${local}/${prefixLength}', overlapping '${INSTALLER_SPEC.network.ipv4Subnet}'.`,
        reason: 'The installer-owned bridge gateway and DHCP range must not collide with another host network.',
        operatorAction:
          'Review and reconfigure the conflicting host network manually. Qiln will not modify host interfaces or addresses.',
        rerun: 'qiln doctor',
      })
    }
  }
}

export async function validateNetworkPreflight(
  host: HostPreflight,
  client: LocalIncusClient,
): Promise<NetworkPreflight> {
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
      networks.find(network => network.name === INSTALLER_SPEC.network.name) ??
      (await client.getNetworkOrNull(INSTALLER_SPEC.network.name))
  } catch (error: unknown) {
    throw toInstallerError(error, {
      check: 'existing incusbr0 inspection',
      operation: `inspect the '${INSTALLER_SPEC.network.name}' network`,
      rerun: 'qiln doctor',
    })
  }
  if (existingTargetNetwork) {
    assertCompatibleNetwork(existingTargetNetwork)
  }
  await assertNoIncusNetworkConflict(networks, existingTargetNetwork)
  await assertNoHostRouteConflict(host, existingTargetNetwork)
  return {
    network: existingTargetNetwork,
    disposition: existingTargetNetwork ? 'existing-compatible' : 'ready-to-create',
  }
}
