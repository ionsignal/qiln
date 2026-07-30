import {
  CapsuleRouteConfigurationKeySchema,
  digestCapsuleRouteConfiguration,
  verifyCapsuleRouteApplicationPin,
} from '@qiln/core/server'
import { CaddyPreviewRouteSchema } from '../../../../caddy'
import { IncusError } from '../../../../errors'
import type { PreviewPlan, PreviewRecord } from './types'

export class PreviewPlanner {
  public create(preview: PreviewRecord, runtimeIp: string): PreviewPlan {
    const application = verifyCapsuleRouteApplicationPin(preview.applicationPin)
    const dial = `${this.formatIp(runtimeIp)}:${application.application.port}`
    const route = CaddyPreviewRouteSchema.safeParse({
      '@id': preview.providerRouteId,
      match: [
        {
          host: [preview.host],
        },
      ],
      handle: [
        {
          handler: 'reverse_proxy',
          upstreams: [
            {
              dial,
            },
          ],
        },
      ],
      terminal: true,
    })
    if (!route.success) {
      throw new IncusError('Preview route cannot produce a safe private Caddy configuration.', 'CONFLICT', {
        previewId: preview.id,
        branchId: preview.branchId,
        applicationName: preview.applicationName,
        runtimeIp,
      })
    }
    const configuration = route.data as Record<string, unknown>
    const configurationKey = CapsuleRouteConfigurationKeySchema.parse(preview.providerRouteId)
    return {
      previewId: preview.id,
      ownerId: preview.ownerId,
      capsuleId: preview.capsuleId,
      branchId: preview.branchId,
      applicationName: preview.applicationName,
      application,
      host: preview.host,
      providerRouteId: preview.providerRouteId,
      runtimeIp,
      port: application.application.port,
      verificationMethod: application.application.verification.method,
      verificationPath: application.application.verification.path,
      expectedStatuses: application.application.verification.expected_statuses,
      route: route.data,
      configurationKey,
      configurationDigest: digestCapsuleRouteConfiguration(configuration),
      configuration,
    }
  }

  private formatIp(value: string): string {
    return value.includes(':') ? `[${value}]` : value
  }
}
