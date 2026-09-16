import { createHash } from 'node:crypto'
import { z } from 'zod'
import { CapsuleRouteHostSchema } from '@qiln/core/server'
import { CaddyPreviewRouteIdSchema } from '../../../../caddy'
import { IncusError } from '../../../../errors'
import type { PreviewIdentity } from './types'

function compactUuid(value: string): string {
  const parsed = z.uuid().safeParse(value)
  if (!parsed.success) {
    throw new IncusError('Preview identity requires a valid branch UUID.', 'VALIDATION_ERROR', {
      branchId: value,
    })
  }
  return parsed.data.replaceAll('-', '').toLowerCase()
}

function applicationDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

/**
 * Stable provider identity is independent from hostname allocation.
 */
export function previewRouteId(branchId: string, applicationName: string): string {
  return CaddyPreviewRouteIdSchema.parse(
    `qiln-preview-${compactUuid(branchId)}-${applicationDigest(applicationName)}`,
  )
}

/**
 * Allocates collision-resistant provider and hostname identities without using
 * mutable branch names as infrastructure authority.
 */
export class PreviewHost {
  constructor(private readonly baseDomain: string) {}

  public create(branchId: string, applicationName: string): PreviewIdentity {
    const providerRouteId = previewRouteId(branchId, applicationName)
    const host = `preview-${compactUuid(branchId)}-${applicationDigest(applicationName)}.${this.baseDomain}`
    const parsedHost = CapsuleRouteHostSchema.safeParse(host)
    if (!parsedHost.success) {
      throw new IncusError('Generated preview hostname failed validation.', 'VALIDATION_ERROR', {
        branchId,
        applicationName,
        host,
      })
    }
    return {
      providerRouteId,
      host: parsedHost.data,
    }
  }
}
