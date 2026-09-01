import { lstat } from 'node:fs/promises'
import { QilnInstallerError } from '../error'
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
      throw new QilnInstallerError({
        code: 'INVALID_INCUS_SOCKET',
        check: 'local Incus Unix socket',
        summary: 'The configured local Incus endpoint is not a Unix socket.',
        observed: `${socketPath} exists but is not a socket.`,
        reason:
          'The installer is restricted to the local Incus Unix API and will not use a redirected file or remote endpoint.',
        operatorAction: 'Inspect the Incus installation and restore the documented local daemon socket manually.',
        rerun: 'qiln doctor',
      })
    }
  } catch (error: unknown) {
    if (error instanceof QilnInstallerError) {
      throw error
    }
    throw new QilnInstallerError({
      code: 'INCUS_SOCKET_UNAVAILABLE',
      check: 'local Incus Unix socket',
      summary: 'The local Incus Unix socket is unavailable.',
      observed: `The installer could not inspect ${socketPath}.`,
      reason: 'Qiln does not install, enable, start, or repair the Incus service.',
      operatorAction:
        "Install Incus through the approved Ubuntu/Zabbly procedure, run 'sudo systemctl enable --now incus' after review, and grant the developer access through the incus-admin group. Start a new login session after changing group membership.",
      rerun: 'qiln doctor',
      cause: error,
    })
  }
  const client = new LocalIncusClient({
    socketPath,
    requestTimeoutMs: INSTALLER_SPEC.incus.requestTimeoutMs,
    maximumResponseBytes: INSTALLER_SPEC.incus.maximumResponseBytes,
  })
  let server: IncusServer
  try {
    server = await client.getServer()
  } catch (error: unknown) {
    if (error instanceof IncusTransportError) {
      throw new QilnInstallerError({
        code: 'INCUS_ACCESS_UNAVAILABLE',
        check: 'authorized local Incus API access',
        summary: 'The invoking developer cannot reach the local Incus API.',
        observed: `A bounded GET /1.0 request through ${socketPath} failed.`,
        reason: 'Qiln never invokes sudo or a privileged helper to obtain Incus authority.',
        operatorAction:
          "Verify that Incus is running, add the developer to incus-admin after review with 'sudo usermod -aG incus-admin <developer>', and start a new login session before retrying.",
        rerun: 'qiln doctor',
        cause: error,
      })
    }
    if (error instanceof IncusApiError) {
      throw new QilnInstallerError({
        code: 'INCUS_API_REJECTED',
        check: 'authorized local Incus API access',
        summary: 'The local Incus API rejected the invoking developer.',
        observed: `GET /1.0 returned HTTP ${error.statusCode}.`,
        reason: 'The installer requires existing local administrative API authority in the default project.',
        operatorAction:
          'Have the operator provision the invoking developer with reviewed local Incus administrative access, then start a new login session.',
        rerun: 'qiln doctor',
        cause: error,
      })
    }
    if (error instanceof IncusProtocolError) {
      throw new QilnInstallerError({
        code: 'INCUS_PROTOCOL_INCOMPATIBLE',
        check: 'local Incus API response',
        summary: 'The local Incus API returned an incompatible response.',
        observed: 'GET /1.0 did not return the expected bounded Incus response structure.',
        reason: 'Qiln cannot safely infer server capabilities from malformed or unexpected API data.',
        operatorAction:
          'Verify that the endpoint belongs to a supported Incus 7.x daemon and inspect the daemon health manually.',
        rerun: 'qiln doctor',
        cause: error,
      })
    }
    throw error
  }
  if (server.environment.server !== 'incus' || server.public) {
    throw new QilnInstallerError({
      code: 'INCOMPATIBLE_INCUS_SERVER',
      check: 'Incus server identity',
      summary: 'The local endpoint is not a full Incus server.',
      observed: `Server implementation='${server.environment.server}', public=${server.public}.`,
      reason:
        'Qiln requires the local full-featured Incus daemon rather than a public image-only endpoint or another implementation.',
      operatorAction: 'Point the documented local socket path at the supported local Incus daemon.',
      rerun: 'qiln doctor',
    })
  }
  if (server.apiVersion !== '1.0' || server.apiStatus !== 'stable') {
    throw new QilnInstallerError({
      code: 'INCOMPATIBLE_INCUS_API',
      check: 'Incus API version',
      summary: 'The Incus API is not the expected stable 1.0 API.',
      observed: `API version='${server.apiVersion}', status='${server.apiStatus}'.`,
      reason: 'The narrow installer client supports the stable Incus 1.0 response contract only.',
      operatorAction: 'Install and run a supported stable Incus 7.x daemon.',
      rerun: 'qiln doctor',
    })
  }
  const serverMajorVersion = parseIncusMajorVersion(server.environment.serverVersion)
  if (serverMajorVersion !== 7) {
    throw new QilnInstallerError({
      code: 'UNSUPPORTED_INCUS_DAEMON_VERSION',
      check: 'Incus daemon version',
      summary: 'The running Incus daemon is outside the supported version range.',
      observed: `Incus reports server version '${server.environment.serverVersion}'.`,
      reason: `Batch 1 requires a running Incus daemon >= ${INSTALLER_SPEC.supportedHost.minimumIncusVersion} and < ${INSTALLER_SPEC.supportedHost.maximumIncusVersionExclusive}.`,
      operatorAction:
        'Manually install and start a supported Incus 7.x release using the reviewed Ubuntu/Zabbly procedure.',
      rerun: 'qiln doctor',
    })
  }
  if (server.auth !== 'trusted') {
    throw new QilnInstallerError({
      code: 'INCUS_CLIENT_UNTRUSTED',
      check: 'Incus local authorization',
      summary: 'The invoking developer is not trusted by the local Incus API.',
      observed: `Incus reports authentication state '${server.auth}'.`,
      reason: 'The installer requires pre-provisioned authority to inspect and later manage Qiln-owned resources.',
      operatorAction: 'Have the operator grant the developer local incus-admin access and start a new login session.',
      rerun: 'qiln doctor',
    })
  }
  if (server.environment.project !== '' && server.environment.project !== INSTALLER_SPEC.projectName) {
    throw new QilnInstallerError({
      code: 'INCUS_PROJECT_INCOMPATIBLE',
      check: 'Incus default project access',
      summary: 'The local Incus connection is scoped to an unsupported project.',
      observed: `Incus reports current project '${server.environment.project}'.`,
      reason: `The development installer owns resources only in the '${INSTALLER_SPEC.projectName}' project.`,
      operatorAction:
        'Use an incus-admin developer session with access to the default project rather than the restricted user socket.',
      rerun: 'qiln doctor',
    })
  }
  if (!server.environment.architectures.includes(INSTALLER_SPEC.supportedHost.incusArchitecture)) {
    throw new QilnInstallerError({
      code: 'INCUS_ARCHITECTURE_INCOMPATIBLE',
      check: 'Incus server architecture',
      summary: 'The local Incus server does not report the supported architecture.',
      observed: `Incus architectures: ${server.environment.architectures.join(', ') || 'none'}.`,
      reason: 'The initial installer supports native x86_64 container images only.',
      operatorAction: 'Run Qiln on an x86_64 Incus host without relying on foreign-architecture emulation.',
      rerun: 'qiln doctor',
    })
  }
  return {
    client,
    server,
  }
}
