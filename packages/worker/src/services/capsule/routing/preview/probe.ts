import { fetch } from 'undici'
import { CapsuleRouteVerificationEvidenceSchema, type CapsuleRouteVerificationEvidence } from '@qiln/core/server'
import { IncusError } from '../../../../errors'
import { parseRoutingIngressEndpoint } from '../../../../endpoint'
import type { PreviewPlan } from './types'

export interface PreviewProbeOptions {
  ingressEndpoint: string
  timeoutMs: number
}

export class PreviewProbe {
  private readonly ingressBaseUrl: string
  private readonly timeoutMs: number

  constructor(options: PreviewProbeOptions) {
    this.ingressBaseUrl = parseRoutingIngressEndpoint(options.ingressEndpoint).baseUrl
    this.timeoutMs = options.timeoutMs
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
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort()
    }, this.timeoutMs)
    timeout.unref()
    try {
      const response = await fetch(url, {
        method: plan.verificationMethod,
        headers: ingress
          ? {
              Host: plan.host,
            }
          : undefined,
        redirect: 'manual',
        signal: controller.signal,
      })
      try {
        if (!plan.expectedStatuses.includes(response.status)) {
          throw new IncusError(
            ingress
              ? 'Preview route verification returned an unexpected status.'
              : 'Preview upstream verification returned an unexpected status.',
            'CONFLICT',
            {
              previewId: plan.previewId,
              branchId: plan.branchId,
              applicationName: plan.applicationName,
              status: response.status,
              expectedStatuses: plan.expectedStatuses,
              ingress,
            },
          )
        }
      } finally {
        if (response.body) {
          await response.body.cancel().catch(() => {})
        }
      }
    } catch (error: unknown) {
      if (error instanceof IncusError) {
        throw error
      }
      throw new IncusError(
        ingress ? 'Preview route verification failed.' : 'Preview upstream verification failed.',
        'TRANSPORT_ERROR',
        {
          previewId: plan.previewId,
          branchId: plan.branchId,
          applicationName: plan.applicationName,
          ingress,
          timedOut: controller.signal.aborted,
          error:
            error instanceof Error
              ? {
                  name: error.name,
                  message: error.message,
                }
              : {
                  value: error,
                },
        },
      )
    } finally {
      clearTimeout(timeout)
    }
  }
}
