import type { IncusNetworkInterface } from '../schemas/incus'
import type { IncusFilePushOptions } from './client/types'

/**
 * Pure utility to extract the primary IPv4 address from an Incus network state
 * object. Safely ignores loopback interfaces and non-global scopes.
 *
 * @param network The strictly typed network record from IncusState.
 * @returns The IPv4 address string, or null if not yet assigned.
 */
export function extractIpv4(network?: Record<string, IncusNetworkInterface>): string | null {
  if (!network) return null
  for (const [interfaceName, iface] of Object.entries(network)) {
    if (interfaceName === 'lo') continue
    if (!iface.addresses) continue
    for (const addr of iface.addresses) {
      if (addr.family === 'inet' && addr.scope === 'global') {
        return addr.address
      }
    }
  }
  return null
}

/**
 * Translates options into strict X-INCUS-* HTTP headers.
 */
export function buildIncusFileHeaders(options: IncusFilePushOptions): Record<string, string> {
  const headers: Record<string, string> = {}
  if (options.uid !== undefined) headers['X-Incus-uid'] = options.uid.toString()
  if (options.gid !== undefined) headers['X-Incus-gid'] = options.gid.toString()
  if (options.mode !== undefined) headers['X-Incus-mode'] = options.mode
  if (options.type !== undefined) headers['X-Incus-type'] = options.type
  if (options.write !== undefined) headers['X-Incus-write'] = options.write
  return headers
}
