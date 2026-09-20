import {
  CapsuleBlueprintApplicationPathSchema,
  CapsulePreviewUrlSchema,
  CapsuleRouteHostSchema,
} from '@qiln/core/server'
import { parseRoutingPublicOrigin } from '../../../endpoint'
import { IncusError } from '../../../errors'

/**
 * Browser origins are independent of the Worker's internal verification
 * listener. Callers must establish active preview eligibility before issuing a
 * URL.
 */
export class PreviewUrl {
  private readonly origin: string

  constructor(publicOrigin: string) {
    this.origin = parseRoutingPublicOrigin(publicOrigin).baseUrl
  }

  public create(host: string, entrypoint: string): string {
    const hostname = CapsuleRouteHostSchema.parse(host)
    if (
      !CapsuleBlueprintApplicationPathSchema.safeParse(entrypoint).success ||
      /[\u0000-\u0020\u007f\\?#%]/.test(entrypoint)
    ) {
      throw new IncusError('Historical application entrypoint cannot produce a safe preview URL.', 'CONFLICT')
    }
    const url = new URL(this.origin)
    const protocol = url.protocol
    const port = url.port
    url.hostname = hostname
    url.pathname = entrypoint
    if (
      url.hostname !== hostname ||
      url.protocol !== protocol ||
      url.port !== port ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      throw new IncusError('Preview URL does not match its public routing origin and hostname.', 'CONFLICT')
    }
    return CapsulePreviewUrlSchema.parse(url.toString())
  }
}
