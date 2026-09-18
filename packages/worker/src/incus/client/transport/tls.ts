import { IncusError } from '../../../errors'
import type { WorkerIncusConfig } from '../../../types'

export interface IncusTlsOptions {
  rejectUnauthorized: boolean
  cert?: string
  key?: string
}

/**
 * Resolves the same remote TLS policy for HTTP and operation-event connections.
 *
 * Client certificates are optional, but partial mTLS configuration must fail
 * before either transport opens a connection.
 */
export function resolveTls(config: WorkerIncusConfig): IncusTlsOptions {
  const { cert, key } = config
  const verifyServerCertificate = config.rejectUnauthorized ?? true
  if ((cert === undefined) !== (key === undefined)) {
    throw new IncusError('Incus client certificate and key must be supplied together.', 'VALIDATION_ERROR')
  }
  if (cert !== undefined && key !== undefined) {
    if (cert.trim() === '' || key.trim() === '') {
      throw new IncusError('Incus client certificate and key must be non-empty.', 'VALIDATION_ERROR')
    }
    return {
      rejectUnauthorized: verifyServerCertificate,
      cert,
      key,
    }
  }
  return {
    rejectUnauthorized: verifyServerCertificate,
  }
}
