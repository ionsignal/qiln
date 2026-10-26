import { lstat } from 'node:fs/promises'
import { InstallerError } from '../../diagnostic/error'
import { INSTALLER_SPEC } from '../spec'
import { requireIncusArchitecture, type Architecture } from '../architecture'
import {
  IncusApiError,
  IncusCancelledError,
  IncusProtocolError,
  IncusTransportError,
  IncusClient,
} from '../../transport/incus/client'
import { localConnection, type IncusConnection } from '../../transport/incus/connection'
import type { IncusServer } from '../../transport/incus/types'

export interface IncusPreflight {
  client: IncusClient
  server: IncusServer
}

function parseIncusMajorVersion(value: string): number | null {
  const match = /^(\d+)(?:\.\d+){1,3}(?:[-+~].*)?$/.exec(value)
  if (!match) {
    return null
  }
  const major = Number(match[1])
  return Number.isSafeInteger(major) ? major : null
}

/**
 * Builds the installer's client over any connection, so a local socket and a
 * relayed one share the same project, limits, and cancellation.
 */
export function createIncusClient(connection: IncusConnection, signal: AbortSignal): IncusClient {
  return new IncusClient({
    connection,
    signal,
    projectName: INSTALLER_SPEC.projectName,
    requestTimeoutMs: INSTALLER_SPEC.incus.requestTimeoutMs,
    uploadTimeoutMs: INSTALLER_SPEC.incus.uploadTimeoutMs,
    operationWaitTimeoutMs: INSTALLER_SPEC.incus.operationWaitTimeoutMs,
    maximumResponseBytes: INSTALLER_SPEC.incus.maximumResponseBytes,
  })
}

/**
 * `endpoint` only names where the request travelled, for the diagnostic.
 */
export async function readIncusServer(client: IncusClient, endpoint: string, retry: string): Promise<IncusServer> {
  try {
    return await client.getServer()
  } catch (error: unknown) {
    if (error instanceof IncusCancelledError) {
      throw new InstallerError({
        code: 'COMMAND_CANCELLED',
      })
    }
    if (error instanceof IncusTransportError) {
      throw new InstallerError({
        code: 'INCUS_ACCESS_UNAVAILABLE',
        facts: [['Observed', `A bounded GET /1.0 request through ${endpoint} failed.`]],
        retry,
      })
    }
    if (error instanceof IncusApiError) {
      throw new InstallerError({
        code: 'INCUS_API_REJECTED',
        facts: [['Observed', `GET /1.0 returned HTTP ${error.statusCode}.`]],
        retry,
      })
    }
    if (error instanceof IncusProtocolError) {
      throw new InstallerError({
        code: 'INCUS_PROTOCOL_INCOMPATIBLE',
        facts: [['Observed', 'GET /1.0 did not return the expected bounded Incus response structure.']],
        retry,
      })
    }
    throw error
  }
}

export function validateIncusServer(server: IncusServer, architecture: Architecture, retry: string): void {
  if (server.environment.server !== 'incus' || server.public) {
    throw new InstallerError({
      code: 'INCOMPATIBLE_INCUS_SERVER',
      facts: [['Observed', `Server implementation='${server.environment.server}', public=${server.public}.`]],
      retry,
    })
  }
  if (server.apiVersion !== '1.0' || server.apiStatus !== 'stable') {
    throw new InstallerError({
      code: 'INCOMPATIBLE_INCUS_API',
      facts: [['Observed', `API version='${server.apiVersion}', status='${server.apiStatus}'.`]],
      retry,
    })
  }
  const serverMajorVersion = parseIncusMajorVersion(server.environment.serverVersion)
  if (serverMajorVersion !== 7) {
    throw new InstallerError({
      code: 'UNSUPPORTED_INCUS_DAEMON_VERSION',
      facts: [['Observed', `Incus reports server version '${server.environment.serverVersion}'.`]],
      retry,
    })
  }
  if (server.auth !== 'trusted') {
    throw new InstallerError({
      code: 'INCUS_CLIENT_UNTRUSTED',
      facts: [['Observed', `Incus reports authentication state '${server.auth}'.`]],
      retry,
    })
  }
  if (server.environment.project !== '' && server.environment.project !== INSTALLER_SPEC.projectName) {
    throw new InstallerError({
      code: 'INCUS_PROJECT_INCOMPATIBLE',
      facts: [['Observed', `Incus reports current project '${server.environment.project}'.`]],
      retry,
    })
  }
  requireIncusArchitecture(architecture, server.environment.architectures, retry)
}

export function requireIncusExtensions(extensions: readonly string[], retry: string): void {
  const missing = INSTALLER_SPEC.incus.requiredExtensions.filter(extension => !extensions.includes(extension))
  if (missing.length === 0) {
    return
  }
  throw new InstallerError({
    code: 'INCUS_CAPABILITY_MISSING',
    facts: [['Missing extensions', missing.join(', ')]],
    retry,
  })
}

export async function validateLocalIncus(
  architecture: Architecture,
  retry: string,
  signal: AbortSignal,
): Promise<IncusPreflight> {
  const socketPath = INSTALLER_SPEC.incus.socketPath
  try {
    const metadata = await lstat(socketPath)
    if (!metadata.isSocket()) {
      throw new InstallerError({
        code: 'INVALID_INCUS_SOCKET',
        facts: [['Observed', `${socketPath} exists but is not a socket.`]],
        retry,
      })
    }
  } catch (error: unknown) {
    if (error instanceof InstallerError) {
      throw error
    }
    throw new InstallerError({
      code: 'INCUS_SOCKET_UNAVAILABLE',
      facts: [['Observed', `The installer could not inspect ${socketPath}.`]],
      retry,
    })
  }
  const client = createIncusClient(localConnection(socketPath), signal)
  const server = await readIncusServer(client, socketPath, retry)
  validateIncusServer(server, architecture, retry)
  return {
    client,
    server,
  }
}
