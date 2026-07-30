import { createHash } from 'node:crypto'
import { CapsuleRouteHostSchema } from '@qiln/core/server'
import { CaddyPreviewRouteIdSchema } from '../../../../caddy'
import { IncusError } from '../../../../errors'
import type { PreviewIdentity } from './types'

function compactUuid(value: string): string {
  const compact = value.replaceAll('-', '').toLowerCase()

  if (!/^[a-f0-9]{32}$/.test(compact)) {
    throw new IncusError('Preview hostname allocation requires a valid branch UUID.', 'VALIDATION_ERROR', {
      branchId: value,
    })
  }

  return compact
}

function applicationDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

/**
 * Allocates collision-resistant provider and hostname identities without using
 * mutable branch names as infrastructure authority.
 */
export class PreviewHost {
  constructor(private readonly baseDomain: string) {}

  public create(branchId: string, applicationName: string): PreviewIdentity {
    const branch = compactUuid(branchId)
    const application = applicationDigest(applicationName)
    const providerRouteId = `qiln-preview-${branch}-${application}`
    const host = `preview-${branch}-${application}.${this.baseDomain}`
    const parsedRouteId = CaddyPreviewRouteIdSchema.safeParse(providerRouteId)
    const parsedHost = CapsuleRouteHostSchema.safeParse(host)
    if (!parsedRouteId.success || !parsedHost.success) {
      throw new IncusError('Generated preview route identity failed validation.', 'VALIDATION_ERROR', {
        branchId,
        applicationName,
        providerRouteId,
        host,
      })
    }
    return {
      providerRouteId: parsedRouteId.data,
      host: parsedHost.data,
    }
  }
}
