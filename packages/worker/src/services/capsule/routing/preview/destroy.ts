import {
  digestCapsuleRouteConfiguration,
  verifyCapsuleRouteApplicationPin,
  type CapsuleRouteApplicationPin,
} from '@qiln/core/server'
import { CaddyPreviewRouteSchema, type CaddyClient } from '../../../../caddy'
import { IncusError } from '../../../../errors'
import type { CapsulePreviewEventPublisher } from '../../events'
import type { PreviewHost } from './host'
import type { PreviewDestroyPersistence, PreviewDestroySource } from './persistence/destroy'
import type { PreviewRecord } from './types'

export interface PreviewDestroyDependencies {
  persistence: PreviewDestroyPersistence
  caddy: CaddyClient
  host: PreviewHost
  events: CapsulePreviewEventPublisher
}

/**
 * Explicit force-destroy withdrawal, separate from ordinary reconciliation.
 *
 * Route IDs alone never authorize deletion. Caddy must contain a configuration
 * matching independently validated current or pending durable evidence.
 */
export class PreviewDestroy {
  constructor(private readonly dependencies: PreviewDestroyDependencies) {}

  public async withdraw(operationId: string): Promise<void> {
    const previews = await this.dependencies.persistence.load(operationId)
    for (const preview of previews) {
      await this.withdrawPreview(operationId, preview)
    }
    await this.dependencies.persistence.assertWithdrawn(operationId)
  }

  private async withdrawPreview(operationId: string, observed: PreviewRecord): Promise<void> {
    let preview = observed
    try {
      this.validate(preview)
      const state = await this.dependencies.caddy.routes.read()
      const route = state.routes.find(entry => entry.id === preview.providerRouteId)
      if (!route) {
        this.changed(await this.dependencies.persistence.inactive(operationId, preview))
        return
      }
      const digest = digestCapsuleRouteConfiguration(route.route)
      const source: PreviewDestroySource | null =
        digest === preview.pendingConfigurationDigest
          ? 'pending'
          : digest === preview.currentConfigurationDigest
            ? 'current'
            : null
      if (source === null) {
        throw new IncusError('Observed Caddy preview configuration is outside force-destroy withdrawal authority.', 'CONFLICT', {
          operationId,
          previewId: preview.id,
          providerRouteId: preview.providerRouteId,
        })
      }
      preview = this.changed(await this.dependencies.persistence.removing(operationId, preview, source))
      const remaining = await this.dependencies.caddy.routes.delete(preview.providerRouteId, state)
      if (remaining.routes.some(entry => entry.id === preview.providerRouteId)) {
        throw new IncusError('Caddy did not confirm preview absence after force-destroy withdrawal.', 'CONFLICT', {
          operationId,
          previewId: preview.id,
        })
      }
      this.changed(await this.dependencies.persistence.inactive(operationId, preview))
    } catch (error: unknown) {
      try {
        const classified = await this.dependencies.persistence.cleanup(operationId, preview, error)
        if (classified) {
          this.changed(classified)
        }
      } catch (classificationError: unknown) {
        throw new AggregateError(
          [error, classificationError],
          'Force-destroy preview withdrawal failed and its cleanup state could not be persisted.',
        )
      }
      throw error
    }
  }

  private validate(preview: PreviewRecord): void {
    const application = verifyCapsuleRouteApplicationPin(preview.applicationPin)
    const identity = this.dependencies.host.create(preview.branchId, application.application.name)
    if (
      preview.applicationName !== application.application.name ||
      preview.host !== identity.host ||
      preview.providerRouteId !== identity.providerRouteId
    ) {
      throw new IncusError('Force-destroy preview identity does not match its branch application.', 'CONFLICT', {
        previewId: preview.id,
        branchId: preview.branchId,
      })
    }
    this.validateConfiguration(preview, application, 'current')
    this.validateConfiguration(preview, application, 'pending')
  }

  private validateConfiguration(
    preview: PreviewRecord,
    application: CapsuleRouteApplicationPin,
    source: PreviewDestroySource,
  ): void {
    const runtimeIp = source === 'pending' ? preview.pendingRuntimeIp : preview.currentRuntimeIp
    const key = source === 'pending' ? preview.pendingConfigurationKey : preview.currentConfigurationKey
    const digest = source === 'pending' ? preview.pendingConfigurationDigest : preview.currentConfigurationDigest
    const configuration = source === 'pending' ? preview.pendingConfiguration : preview.currentConfiguration
    const timestamp = source === 'pending' ? preview.applyIntentAt : preview.appliedAt
    if (runtimeIp === null && key === null && digest === null && configuration === null && timestamp === null) {
      return
    }
    if (
      runtimeIp === null ||
      key !== preview.providerRouteId ||
      digest === null ||
      configuration === null ||
      !(timestamp instanceof Date) ||
      !Number.isFinite(timestamp.getTime())
    ) {
      throw new IncusError('Force-destroy preview configuration evidence is incomplete.', 'CONFLICT', {
        previewId: preview.id,
        source,
      })
    }
    const route = CaddyPreviewRouteSchema.safeParse(configuration)
    const host = runtimeIp.includes(':') ? `[${runtimeIp}]` : runtimeIp
    if (
      !route.success ||
      route.data['@id'] !== preview.providerRouteId ||
      route.data.match[0].host[0] !== preview.host ||
      route.data.handle[0].upstreams[0].dial !== `${host}:${application.application.port}` ||
      digestCapsuleRouteConfiguration(configuration) !== digest
    ) {
      throw new IncusError('Force-destroy preview configuration does not match its durable identity and digest.', 'CONFLICT', {
        previewId: preview.id,
        source,
      })
    }
  }

  private changed(preview: PreviewRecord): PreviewRecord {
    this.dependencies.events.changed(preview)
    return preview
  }
}
