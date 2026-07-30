import { z } from 'zod'
import { CaddyError, CaddyErrorCode, CaddyMutationOutcome, caddyErrorDetailsFromUnknown } from './error'
import {
  CaddyFallbackRouteSchema,
  CaddyManagedRouteIdSchema,
  CaddyManagedRouteSchema,
  CaddyRouteArraySchema,
  CaddyRoutesStateSchema,
  CaddyEtagSchema,
} from './schema'
import { CaddyHttp } from './transport'
import type { CaddyManagedRoute, CaddyManagedRouteEntry, CaddyRoutesState } from './types'

interface CaddyRoutesClientOptions {
  server: string
  fallbackId: string
}

interface ExpectedRoute {
  id: string
  route: CaddyManagedRoute
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function areJsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false
    }
    return left.every((value, index) => areJsonValuesEqual(value, right[index]))
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) {
      return false
    }
    const leftKeys = Object.keys(left).sort()
    const rightKeys = Object.keys(right).sort()
    if (leftKeys.length !== rightKeys.length) {
      return false
    }
    for (const [index, key] of leftKeys.entries()) {
      if (key !== rightKeys[index] || !areJsonValuesEqual(left[key], right[key])) {
        return false
      }
    }
    return true
  }
  return false
}

/**
 * Controls only Qiln-managed route objects within one infrastructure-owned
 * Caddy route array. It never traverses arbitrary config paths or attempts to
 * repair a route table whose ownership boundary cannot be proven.
 */
export class CaddyRoutesClient {
  private readonly routeTablePath: string

  constructor(
    private readonly transport: CaddyHttp,
    private readonly options: CaddyRoutesClientOptions,
  ) {
    this.routeTablePath = `/config/apps/http/servers/${encodeURIComponent(options.server)}/routes`
  }

  public async read(): Promise<CaddyRoutesState> {
    const response = await this.transport.getJson(this.routeTablePath)
    return this.parseManagedRouteTable(response.data, response.etag)
  }

  public async create(route: CaddyManagedRoute, state: CaddyRoutesState): Promise<CaddyRoutesState> {
    const desiredRoute = this.parseRoute(route, 'Caddy route create route')
    const inspectedState = this.parseState(state, 'Caddy route create state')
    const routeId = desiredRoute['@id']
    if (this.findRoute(inspectedState, routeId)) {
      throw new CaddyError(`Caddy route '${routeId}' already exists in the supplied route state.`, {
        code: CaddyErrorCode.CONFLICT,
        outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
        details: {
          routeId,
        },
      })
    }
    const insertionIndex = inspectedState.routes.length
    await this.transport.putJson(this.routePositionPath(insertionIndex), desiredRoute, inspectedState.etag)
    const observedState = await this.readAfterMutation('create', routeId)
    const expectedRoutes = [
      ...this.expectedRoutesFromState(inspectedState),
      {
        id: routeId,
        route: desiredRoute,
      },
    ]

    this.assertExpectedRoutes(observedState, expectedRoutes, 'create', routeId)

    return observedState
  }

  public async replace(route: CaddyManagedRoute, state: CaddyRoutesState): Promise<CaddyRoutesState> {
    const desiredRoute = this.parseRoute(route, 'Caddy route replace route')
    const inspectedState = this.parseState(state, 'Caddy route replace state')
    const routeId = desiredRoute['@id']
    const existingRoute = this.findRoute(inspectedState, routeId)
    if (!existingRoute) {
      throw new CaddyError(`Caddy route '${routeId}' does not exist in the supplied route state.`, {
        code: CaddyErrorCode.NOT_FOUND,
        outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
        details: {
          routeId,
        },
      })
    }
    await this.transport.patchJson(this.routePositionPath(existingRoute.index), desiredRoute, inspectedState.etag)
    const observedState = await this.readAfterMutation('replace', routeId)
    const expectedRoutes = this.expectedRoutesFromState(inspectedState).map(route =>
      route.id === routeId
        ? {
            id: routeId,
            route: desiredRoute,
          }
        : route,
    )

    this.assertExpectedRoutes(observedState, expectedRoutes, 'replace', routeId)

    return observedState
  }

  public async delete(routeId: string, state: CaddyRoutesState): Promise<CaddyRoutesState> {
    const parsedRouteId = this.parseRouteId(routeId)
    const inspectedState = this.parseState(state, 'Caddy route delete state')
    const existingRoute = this.findRoute(inspectedState, parsedRouteId)
    if (!existingRoute) {
      throw new CaddyError(`Caddy route '${parsedRouteId}' does not exist in the supplied route state.`, {
        code: CaddyErrorCode.NOT_FOUND,
        outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
        details: {
          routeId: parsedRouteId,
        },
      })
    }
    await this.transport.delete(this.routePositionPath(existingRoute.index), inspectedState.etag)
    const observedState = await this.readAfterMutation('delete', parsedRouteId)
    const expectedRoutes = this.expectedRoutesFromState(inspectedState).filter(route => route.id !== parsedRouteId)

    this.assertExpectedRoutes(observedState, expectedRoutes, 'delete', parsedRouteId)

    return observedState
  }

  private parseManagedRouteTable(value: unknown, etag: string | undefined): CaddyRoutesState {
    const parsedEtag = CaddyEtagSchema.safeParse(etag)
    if (!parsedEtag.success) {
      throw new CaddyError('Caddy route-array read did not return a valid ETag.', {
        code: CaddyErrorCode.TRANSPORT_ERROR,
        outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
        details: {
          routeTablePath: this.routeTablePath,
          validation: z.treeifyError(parsedEtag.error),
        },
      })
    }
    const parsedRoutes = CaddyRouteArraySchema.safeParse(value)
    if (!parsedRoutes.success) {
      throw new CaddyError('Caddy managed route table has an unsupported response shape.', {
        code: CaddyErrorCode.UNSUPPORTED_CONFIGURATION,
        outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
        details: {
          routeTablePath: this.routeTablePath,
          validation: z.treeifyError(parsedRoutes.error),
        },
      })
    }
    const routeValues = parsedRoutes.data
    const fallbackIndex = routeValues.length - 1
    const parsedFallback = CaddyFallbackRouteSchema.safeParse(routeValues[fallbackIndex])
    if (!parsedFallback.success) {
      throw new CaddyError('Caddy managed route table does not end with the required Qiln terminal fallback route.', {
        code: CaddyErrorCode.UNSUPPORTED_CONFIGURATION,
        outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
        details: {
          routeTablePath: this.routeTablePath,
          fallbackIndex,
          validation: z.treeifyError(parsedFallback.error),
        },
      })
    }
    if (parsedFallback.data['@id'] !== this.options.fallbackId) {
      throw new CaddyError('Caddy managed route table contains an unexpected terminal fallback route ID.', {
        code: CaddyErrorCode.UNSUPPORTED_CONFIGURATION,
        outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
        details: {
          routeTablePath: this.routeTablePath,
          expectedFallbackId: this.options.fallbackId,
          actualFallbackId: parsedFallback.data['@id'],
        },
      })
    }
    const routes: CaddyManagedRouteEntry[] = []
    const ids = new Set<string>([parsedFallback.data['@id']])
    for (let index = 0; index < fallbackIndex; index++) {
      const parsedRoute = CaddyManagedRouteSchema.safeParse(routeValues[index])
      if (!parsedRoute.success) {
        throw new CaddyError('Caddy managed route table contains an unsupported non-Qiln route.', {
          code: CaddyErrorCode.UNSUPPORTED_CONFIGURATION,
          outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
          details: {
            routeTablePath: this.routeTablePath,
            index,
            validation: z.treeifyError(parsedRoute.error),
          },
        })
      }
      const routeId = parsedRoute.data['@id']
      if (ids.has(routeId)) {
        throw new CaddyError('Caddy managed route table contains duplicate route IDs.', {
          code: CaddyErrorCode.UNSUPPORTED_CONFIGURATION,
          outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
          details: {
            routeTablePath: this.routeTablePath,
            routeId,
          },
        })
      }
      ids.add(routeId)
      routes.push({
        id: routeId,
        index,
        route: parsedRoute.data,
      })
    }
    const parsedState = CaddyRoutesStateSchema.safeParse({
      etag: parsedEtag.data,
      routes,
    })
    if (!parsedState.success) {
      throw new CaddyError('Caddy managed route table could not be represented as valid Qiln route state.', {
        code: CaddyErrorCode.UNSUPPORTED_CONFIGURATION,
        outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
        details: {
          routeTablePath: this.routeTablePath,
          validation: z.treeifyError(parsedState.error),
        },
      })
    }
    return parsedState.data
  }

  private async readAfterMutation(action: string, routeId: string): Promise<CaddyRoutesState> {
    try {
      return await this.read()
    } catch (error: unknown) {
      throw new CaddyError(`Caddy route '${routeId}' ${action} could not be verified after configuration mutation.`, {
        code: CaddyErrorCode.CONFIGURATION_MISMATCH,
        outcome: CaddyMutationOutcome.UNKNOWN,
        details: {
          action,
          routeId,
          error: caddyErrorDetailsFromUnknown(error),
        },
      })
    }
  }

  private assertExpectedRoutes(
    observedState: CaddyRoutesState,
    expectedRoutes: readonly ExpectedRoute[],
    action: string,
    routeId: string,
  ): void {
    if (observedState.routes.length !== expectedRoutes.length) {
      this.throwConfigurationMismatch(action, routeId, {
        expectedRouteCount: expectedRoutes.length,
        actualRouteCount: observedState.routes.length,
      })
    }
    for (const [index, expectedRoute] of expectedRoutes.entries()) {
      const observedRoute = observedState.routes[index]
      if (!observedRoute) {
        this.throwConfigurationMismatch(action, routeId, {
          index,
          expectedRouteId: expectedRoute.id,
          actualRouteId: null,
        })
      }
      if (
        observedRoute.id !== expectedRoute.id ||
        observedRoute.index !== index ||
        !areJsonValuesEqual(observedRoute.route, expectedRoute.route)
      ) {
        this.throwConfigurationMismatch(action, routeId, {
          index,
          expectedRouteId: expectedRoute.id,
          actualRouteId: observedRoute.id,
          expectedRouteIndex: index,
          actualRouteIndex: observedRoute.index,
        })
      }
    }
  }

  private throwConfigurationMismatch(action: string, routeId: string, details: Record<string, unknown>): never {
    throw new CaddyError(`Caddy route '${routeId}' ${action} readback did not match the expected route table.`, {
      code: CaddyErrorCode.CONFIGURATION_MISMATCH,
      outcome: CaddyMutationOutcome.UNKNOWN,
      details: {
        action,
        routeId,
        ...details,
      },
    })
  }

  private parseRoute(value: unknown, context: string): CaddyManagedRoute {
    const parsed = CaddyManagedRouteSchema.safeParse(value)
    if (!parsed.success) {
      throw new CaddyError(`Invalid ${context}.`, {
        code: CaddyErrorCode.VALIDATION_ERROR,
        outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
        details: {
          validation: z.treeifyError(parsed.error),
        },
      })
    }
    return parsed.data
  }

  private parseRouteId(value: unknown): string {
    const parsed = CaddyManagedRouteIdSchema.safeParse(value)
    if (!parsed.success) {
      throw new CaddyError('Invalid Caddy managed route ID.', {
        code: CaddyErrorCode.VALIDATION_ERROR,
        outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
        details: {
          validation: z.treeifyError(parsed.error),
        },
      })
    }
    return parsed.data
  }

  private parseState(value: unknown, context: string): CaddyRoutesState {
    const parsed = CaddyRoutesStateSchema.safeParse(value)
    if (!parsed.success) {
      throw new CaddyError(`Invalid ${context}.`, {
        code: CaddyErrorCode.VALIDATION_ERROR,
        outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
        details: {
          validation: z.treeifyError(parsed.error),
        },
      })
    }
    return parsed.data
  }

  private expectedRoutesFromState(state: CaddyRoutesState): ExpectedRoute[] {
    return state.routes.map(route => ({
      id: route.id,
      route: route.route,
    }))
  }

  private findRoute(state: CaddyRoutesState, routeId: string): CaddyManagedRouteEntry | undefined {
    return state.routes.find(route => route.id === routeId)
  }

  private routePositionPath(index: number): string {
    return `${this.routeTablePath}/${index}`
  }
}
