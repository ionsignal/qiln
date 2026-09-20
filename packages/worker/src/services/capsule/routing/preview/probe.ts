import { CapsuleRouteVerificationEvidenceSchema, type CapsuleRouteVerificationEvidence } from '@qiln/core/server'
import { IncusError } from '../../../../errors'
import { parseRoutingIngressEndpoint } from '../../../../endpoint'
import { RoutingHttpProbe } from '../http'
import type { PreviewPlan } from './types'

export interface PreviewProbeOptions {
  ingressEndpoint: string
  timeoutMs: number
}

export class PreviewProbe {
  private readonly ingressBaseUrl: string
  private readonly http: RoutingHttpProbe

  constructor(options: PreviewProbeOptions) {
    this.ingressBaseUrl = parseRoutingIngressEndpoint(options.ingressEndpoint).baseUrl
    this.http = new RoutingHttpProbe(options.timeoutMs)
  }

  public async upstream(plan: PreviewPlan): Promise<void> {
    await this.request(this.upstreamUrl(plan), plan, false)
  }

  public async route(plan: PreviewPlan): Promise<CapsuleRouteVerificationEvidence> {
    await this.request(this.upstreamUrl(plan), plan, false)
    await this.request(this.ingressUrl(plan), plan, true)
    return CapsuleRouteVerificationEvidenceSchema.parse({
      configurationDigest: plan.configurationDigest,
      upstreamVerified: true,
      routeVerified: true,
      verifiedAt: new Date().toISOString(),
    })
  }

  private upstreamUrl(plan: PreviewPlan): string {
    const host = plan.runtimeIp.includes(':') ? `[${plan.runtimeIp}]` : plan.runtimeIp
    return `http://${host}:${plan.port}${plan.verificationPath}`
  }

  private ingressUrl(plan: PreviewPlan): string {
    return new URL(plan.verificationPath, this.ingressBaseUrl).toString()
  }

  private async request(url: string, plan: PreviewPlan, ingress: boolean): Promise<void> {
    const result = await this.http.request({
      url,
      method: plan.verificationMethod,
      expectedStatuses: plan.expectedStatuses,
      ...(ingress ? { virtualHost: plan.host } : {}),
    })
    if (result.kind === 'success') {
      return
    }
    if (result.kind === 'unexpected_status') {
      throw new IncusError(
        ingress
          ? 'Preview route verification returned an unexpected status.'
          : 'Preview upstream verification returned an unexpected status.',
        'CONFLICT',
        {
          previewId: plan.previewId,
          branchId: plan.branchId,
          applicationName: plan.applicationName,
          status: result.status,
          expectedStatuses: plan.expectedStatuses,
          ingress,
        },
      )
    }
    throw new IncusError(
      ingress ? 'Preview route verification failed.' : 'Preview upstream verification failed.',
      'TRANSPORT_ERROR',
      {
        previewId: plan.previewId,
        branchId: plan.branchId,
        applicationName: plan.applicationName,
        ingress,
        timedOut: result.kind === 'timeout',
        error:
          result.error instanceof Error
            ? {
                name: result.error.name,
                message: result.error.message,
              }
            : {
                value: result.error,
              },
      },
    )
  }
}
