import { lstat } from 'node:fs/promises'
import { InstallerError } from '../diagnostic/error'
import { INSTALLER_SPEC } from '../install/spec'
import { IncusApiError, IncusProtocolError, IncusTransportError, LocalIncusClient } from '../incus/client'
import type { IncusServer } from '../incus/types'

export interface IncusPreflight {
  client: LocalIncusClient
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

export async function validateLocalIncus(): Promise<IncusPreflight> {
  const socketPath = INSTALLER_SPEC.incus.socketPath
  try {
    const metadata = await lstat(socketPath)
    if (!metadata.isSocket()) {
      throw new InstallerError({
        code: 'INVALID_INCUS_SOCKET',
        facts: [['Observed', `${socketPath} exists but is not a socket.`]],
        retry: 'qiln doctor',
      })
    }
  } catch (error: unknown) {
    if (error instanceof InstallerError) {
      throw error
    }
    throw new InstallerError({
      code: 'INCUS_SOCKET_UNAVAILABLE',
      facts: [['Observed', `The installer could not inspect ${socketPath}.`]],
      retry: 'qiln doctor',
    })
  }
  const client = new LocalIncusClient({
    socketPath,
    projectName: INSTALLER_SPEC.projectName,
    requestTimeoutMs: INSTALLER_SPEC.incus.requestTimeoutMs,
    uploadTimeoutMs: INSTALLER_SPEC.incus.uploadTimeoutMs,
    operationWaitTimeoutMs: INSTALLER_SPEC.incus.operationWaitTimeoutMs,
    maximumResponseBytes: INSTALLER_SPEC.incus.maximumResponseBytes,
  })
  let server: IncusServer
  try {
    server = await client.getServer()
  } catch (error: unknown) {
    if (error instanceof IncusTransportError) {
      throw new InstallerError({
        code: 'INCUS_ACCESS_UNAVAILABLE',
        facts: [['Observed', `A bounded GET /1.0 request through ${socketPath} failed.`]],
        retry: 'qiln doctor',
      })
    }
    if (error instanceof IncusApiError) {
      throw new InstallerError({
        code: 'INCUS_API_REJECTED',
        facts: [['Observed', `GET /1.0 returned HTTP ${error.statusCode}.`]],
        retry: 'qiln doctor',
      })
    }
    if (error instanceof IncusProtocolError) {
      throw new InstallerError({
        code: 'INCUS_PROTOCOL_INCOMPATIBLE',
        facts: [['Observed', 'GET /1.0 did not return the expected bounded Incus response structure.']],
        retry: 'qiln doctor',
      })
    }
    throw error
  }
  if (server.environment.server !== 'incus' || server.public) {
    throw new InstallerError({
      code: 'INCOMPATIBLE_INCUS_SERVER',
      facts: [['Observed', `Server implementation='${server.environment.server}', public=${server.public}.`]],
      retry: 'qiln doctor',
    })
  }
  if (server.apiVersion !== '1.0' || server.apiStatus !== 'stable') {
    throw new InstallerError({
      code: 'INCOMPATIBLE_INCUS_API',
      facts: [['Observed', `API version='${server.apiVersion}', status='${server.apiStatus}'.`]],
      retry: 'qiln doctor',
    })
  }
  const serverMajorVersion = parseIncusMajorVersion(server.environment.serverVersion)
  if (serverMajorVersion !== 7) {
    throw new InstallerError({
      code: 'UNSUPPORTED_INCUS_DAEMON_VERSION',
      facts: [['Observed', `Incus reports server version '${server.environment.serverVersion}'.`]],
      retry: 'qiln doctor',
    })
  }
  if (server.auth !== 'trusted') {
    throw new InstallerError({
      code: 'INCUS_CLIENT_UNTRUSTED',
      facts: [['Observed', `Incus reports authentication state '${server.auth}'.`]],
      retry: 'qiln doctor',
    })
  }
  if (server.environment.project !== '' && server.environment.project !== INSTALLER_SPEC.projectName) {
    throw new InstallerError({
      code: 'INCUS_PROJECT_INCOMPATIBLE',
      facts: [['Observed', `Incus reports current project '${server.environment.project}'.`]],
      retry: 'qiln doctor',
    })
  }
  if (!server.environment.architectures.includes(INSTALLER_SPEC.supportedHost.incusArchitecture)) {
    throw new InstallerError({
      code: 'INCUS_ARCHITECTURE_INCOMPATIBLE',
      facts: [['Observed', `Incus architectures: ${server.environment.architectures.join(', ') || 'none'}.`]],
      retry: 'qiln doctor',
    })
  }
  return {
    client,
    server,
  }
}
