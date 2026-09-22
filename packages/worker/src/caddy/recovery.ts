import {
  digestCapsuleRouteConfiguration,
  digestCanonicalJsonValue,
  type CapsuleDestroyObservation,
  type CapsuleDestroyTarget,
} from '@qiln/core/server'
import { CaddyError, CaddyErrorCode, CaddyMutationOutcome, caddyErrorDetailsFromUnknown } from './error'
import { CaddyFallbackRouteSchema, CaddyRecoveryBindingSchema, CaddyRecoveryStateSchema } from './schema'
import type { CaddyHttp } from './transport'
import type { CaddyRecoveryBinding, CaddyRecoveryState } from './types'

type RouteTarget = Extract<CapsuleDestroyTarget, { kind: 'route' }>

interface CaddyRecoveryOptions {
  server: string
  fallbackId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Recovery-only capability for durably attributed route deletion.
 *
 * The caller must obtain its binding from a running destroy operation's
 * verified target ledger and persist intent before delete(). No route-ID
 * prefix, configuration resemblance, or hostname establishes ownership here.
 *
 * Unlike ordinary routing, recovery preserves unsupported route configuration
 * without adopting it or making it eligible for creation or replacement.
 */
export class CaddyRecoveryClient {
  private readonly routeTablePath: string

  constructor(
    private readonly transport: CaddyHttp,
    private readonly options: CaddyRecoveryOptions,
  ) {
    this.routeTablePath = `/config/apps/http/servers/${encodeURIComponent(options.server)}/routes`
  }

  public async read(): Promise<CaddyRecoveryState> {
    const response = await this.transport.getJson(this.routeTablePath)
    return this.state({
      etag: response.etag,
      routes: response.data,
      observedAt: new Date().toISOString(),
    })
  }

  /**
   * Returns exact-target evidence from one authoritative route-array read.
   *
   * Configuration digests retain drift evidence without persisting arbitrary
   * provider configuration that could contain credentials.
   */
  public inspect(binding: CaddyRecoveryBinding, value: CaddyRecoveryState): CapsuleDestroyObservation {
    const target = this.target(binding)
    const state = this.state(value)
    const route = state.routes.find(candidate => candidate['@id'] === target.routeId)
    if (route === undefined && this.containsId(state.routes, target.routeId)) {
      throw new CaddyError('The attributed Caddy route ID exists outside the managed top-level route boundary.', {
        code: CaddyErrorCode.UNSUPPORTED_CONFIGURATION,
        outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
        details: {
          operationId: binding.operationId,
          resourceId: binding.resourceId,
          routeId: target.routeId,
        },
      })
    }
    return {
      target,
      state: route === undefined ? 'absent' : 'present',
      observedAt: state.observedAt,
      details:
        route === undefined
          ? {}
          : {
              configurationDigest: digestCapsuleRouteConfiguration(route),
            },
    }
  }

  /**
   * Deletes the exact inspected array entry using the whole-array ETag.
   *
   * Sibling and fallback configuration must survive unchanged. A stale ETag is
   * rejected rather than retried against a different configuration.
   */
  public async delete(binding: CaddyRecoveryBinding, value: CaddyRecoveryState): Promise<CaddyRecoveryState> {
    const target = this.target(binding)
    const state = this.state(value)
    const index = state.routes.findIndex(route => route['@id'] === target.routeId)
    if (index < 0) {
      throw new CaddyError('The inspected Caddy target is already absent; no deletion was attempted.', {
        code: CaddyErrorCode.NOT_FOUND,
        outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
        details: {
          operationId: binding.operationId,
          resourceId: binding.resourceId,
          routeId: target.routeId,
        },
      })
    }
    const expected = state.routes.filter((_, position) => position !== index)
    const expectedDigest = digestCanonicalJsonValue(expected, {
      context: 'Caddy recovery expected route array',
    })
    await this.transport.delete(`${this.routeTablePath}/${index}`, state.etag)
    let observed: CaddyRecoveryState
    try {
      observed = await this.read()
    } catch (error: unknown) {
      throw new CaddyError('Caddy recovery deletion could not be verified.', {
        code: CaddyErrorCode.CONFIGURATION_MISMATCH,
        outcome: CaddyMutationOutcome.UNKNOWN,
        details: {
          operationId: binding.operationId,
          resourceId: binding.resourceId,
          routeId: target.routeId,
          error: caddyErrorDetailsFromUnknown(error),
        },
      })
    }
    const observedDigest = digestCanonicalJsonValue(observed.routes, {
      context: 'Caddy recovery observed route array',
    })
    if (observedDigest !== expectedDigest) {
      throw new CaddyError('Caddy recovery readback did not preserve the expected route array.', {
        code: CaddyErrorCode.CONFIGURATION_MISMATCH,
        outcome: CaddyMutationOutcome.UNKNOWN,
        details: {
          operationId: binding.operationId,
          resourceId: binding.resourceId,
          routeId: target.routeId,
          expectedDigest,
          observedDigest,
        },
      })
    }
    return observed
  }

  private target(value: CaddyRecoveryBinding): RouteTarget {
    const parsed = CaddyRecoveryBindingSchema.safeParse(value)
    if (!parsed.success || parsed.data.resource.target.kind !== 'route') {
      throw new CaddyError('Caddy recovery requires a valid durable route binding.', {
        code: CaddyErrorCode.VALIDATION_ERROR,
        outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
      })
    }
    const target = parsed.data.resource.target
    if (target.server !== this.options.server || target.routeId === this.options.fallbackId) {
      throw new CaddyError('Caddy recovery target is outside the configured route-array boundary.', {
        code: CaddyErrorCode.CONFLICT,
        outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
        details: {
          operationId: parsed.data.operationId,
          resourceId: parsed.data.resourceId,
          expectedServer: this.options.server,
          targetServer: target.server,
          routeId: target.routeId,
        },
      })
    }
    return target
  }

  private state(value: unknown): CaddyRecoveryState {
    const parsed = CaddyRecoveryStateSchema.safeParse(value)
    if (!parsed.success) {
      throw new CaddyError('Caddy recovery route-array state is invalid.', {
        code: CaddyErrorCode.UNSUPPORTED_CONFIGURATION,
        outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
      })
    }
    const state = parsed.data
    const fallback = CaddyFallbackRouteSchema.safeParse(state.routes[state.routes.length - 1])
    if (!fallback.success || fallback.data['@id'] !== this.options.fallbackId) {
      throw new CaddyError('Caddy recovery requires the exact infrastructure-owned terminal fallback.', {
        code: CaddyErrorCode.UNSUPPORTED_CONFIGURATION,
        outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
        details: {
          expectedFallbackId: this.options.fallbackId,
        },
      })
    }
    digestCanonicalJsonValue(state.routes, {
      context: 'Caddy recovery route array',
    })
    const ids = new Set<string>()
    for (const route of state.routes) {
      this.collectIds(route, ids)
    }
    return state
  }

  private containsId(value: unknown, id: string): boolean {
    if (Array.isArray(value)) {
      return value.some(child => this.containsId(child, id))
    }
    if (!isRecord(value)) {
      return false
    }
    return value['@id'] === id || Object.values(value).some(child => this.containsId(child, id))
  }

  private collectIds(value: unknown, ids: Set<string>): void {
    if (Array.isArray(value)) {
      for (const child of value) {
        this.collectIds(child, ids)
      }
      return
    }
    if (!isRecord(value)) {
      return
    }
    if (Object.prototype.hasOwnProperty.call(value, '@id')) {
      const id = value['@id']
      if (typeof id !== 'string' || id === '' || ids.has(id)) {
        throw new CaddyError('Caddy recovery cannot use ambiguous route-array IDs.', {
          code: CaddyErrorCode.UNSUPPORTED_CONFIGURATION,
          outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
        })
      }
      ids.add(id)
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== '@id') {
        this.collectIds(child, ids)
      }
    }
  }
}
