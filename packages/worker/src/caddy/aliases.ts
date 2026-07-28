import { z } from 'zod'
import { CaddyError, CaddyErrorCode, CaddyMutationOutcome, caddyErrorDetailsFromUnknown } from './error'
import {
  CaddyAliasRouteIdSchema,
  CaddyAliasRouteSchema,
  CaddyAliasesStateSchema,
  CaddyEtagSchema,
  CaddyFallbackRouteSchema,
  CaddyRouteArraySchema,
} from './schema'
import { CaddyHttp } from './transport'
import type { CaddyAliasRoute, CaddyAliasRouteEntry, CaddyAliasesState } from './types'

interface CaddyAliasesClientOptions {
  server: string
  fallbackId: string
}

interface ExpectedAlias {
  id: string
  route: CaddyAliasRoute
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
 * Controls only Qiln-owned alias route objects within one infrastructure-owned
 * Caddy route array. It never traverses arbitrary config paths or attempts to
 * repair a route table whose ownership boundary cannot be proven.
 */
export class CaddyAliasesClient {
  private readonly routeTablePath: string

  constructor(
    private readonly transport: CaddyHttp,
    private readonly options: CaddyAliasesClientOptions,
  ) {
    this.routeTablePath = `/config/apps/http/servers/${encodeURIComponent(options.server)}/routes`
  }

  public async read(): Promise<CaddyAliasesState> {
    const response = await this.transport.getJson(this.routeTablePath)
    return this.parseManagedRouteTable(response.data, response.etag)
  }

  public async create(route: CaddyAliasRoute, state: CaddyAliasesState): Promise<CaddyAliasesState> {
    const desiredRoute = this.parseAliasRoute(route, 'Caddy alias create route')
    const inspectedState = this.parseState(state, 'Caddy alias create state')
    const ids = desiredRoute['@id']
    if (this.findAlias(inspectedState, ids)) {
      throw new CaddyError(`Caddy alias '${ids}' already exists in the supplied route state.`, {
        code: CaddyErrorCode.CONFLICT,
        outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
        details: {
          aliasId: ids,
        },
      })
    }
    const insertionIndex = inspectedState.aliases.length
    await this.transport.putJson(this.routePositionPath(insertionIndex), desiredRoute, inspectedState.etag)
    const observedState = await this.readAfterMutation('create', ids)
    const expectedAliases = [
      ...this.expectedAliasesFromState(inspectedState),
      {
        id: ids,
        route: desiredRoute,
      },
    ]

    this.assertExpectedAliases(observedState, expectedAliases, 'create', ids)

    return observedState
  }

  public async replace(route: CaddyAliasRoute, state: CaddyAliasesState): Promise<CaddyAliasesState> {
    const desiredRoute = this.parseAliasRoute(route, 'Caddy alias replace route')
    const inspectedState = this.parseState(state, 'Caddy alias replace state')
    const aliasId = desiredRoute['@id']
    const existingAlias = this.findAlias(inspectedState, aliasId)
    if (!existingAlias) {
      throw new CaddyError(`Caddy alias '${aliasId}' does not exist in the supplied route state.`, {
        code: CaddyErrorCode.NOT_FOUND,
        outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
        details: {
          aliasId,
        },
      })
    }
    await this.transport.patchJson(this.routePositionPath(existingAlias.index), desiredRoute, inspectedState.etag)
    const observedState = await this.readAfterMutation('replace', aliasId)
    const expectedAliases = this.expectedAliasesFromState(inspectedState).map(alias =>
      alias.id === aliasId
        ? {
            id: aliasId,
            route: desiredRoute,
          }
        : alias,
    )

    this.assertExpectedAliases(observedState, expectedAliases, 'replace', aliasId)

    return observedState
  }

  public async delete(aliasId: string, state: CaddyAliasesState): Promise<CaddyAliasesState> {
    const parsedAliasId = this.parseAliasId(aliasId)
    const inspectedState = this.parseState(state, 'Caddy alias delete state')
    const existingAlias = this.findAlias(inspectedState, parsedAliasId)
    if (!existingAlias) {
      throw new CaddyError(`Caddy alias '${parsedAliasId}' does not exist in the supplied route state.`, {
        code: CaddyErrorCode.NOT_FOUND,
        outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
        details: {
          aliasId: parsedAliasId,
        },
      })
    }
    await this.transport.delete(this.routePositionPath(existingAlias.index), inspectedState.etag)
    const observedState = await this.readAfterMutation('delete', parsedAliasId)
    const expectedAliases = this.expectedAliasesFromState(inspectedState).filter(alias => alias.id !== parsedAliasId)

    this.assertExpectedAliases(observedState, expectedAliases, 'delete', parsedAliasId)

    return observedState
  }

  private parseManagedRouteTable(value: unknown, etag: string | undefined): CaddyAliasesState {
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
    const aliases: CaddyAliasRouteEntry[] = []
    const ids = new Set<string>([parsedFallback.data['@id']])
    for (let index = 0; index < fallbackIndex; index++) {
      const parsedAlias = CaddyAliasRouteSchema.safeParse(routeValues[index])
      if (!parsedAlias.success) {
        throw new CaddyError('Caddy managed route table contains an unsupported non-alias route.', {
          code: CaddyErrorCode.UNSUPPORTED_CONFIGURATION,
          outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
          details: {
            routeTablePath: this.routeTablePath,
            index,
            validation: z.treeifyError(parsedAlias.error),
          },
        })
      }
      const aliasId = parsedAlias.data['@id']
      if (ids.has(aliasId)) {
        throw new CaddyError('Caddy managed route table contains duplicate route IDs.', {
          code: CaddyErrorCode.UNSUPPORTED_CONFIGURATION,
          outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
          details: {
            routeTablePath: this.routeTablePath,
            aliasId,
          },
        })
      }
      ids.add(aliasId)
      aliases.push({
        id: aliasId,
        index,
        route: parsedAlias.data,
      })
    }
    const parsedState = CaddyAliasesStateSchema.safeParse({
      etag: parsedEtag.data,
      aliases,
    })
    if (!parsedState.success) {
      throw new CaddyError('Caddy managed route table could not be represented as a valid Qiln alias state.', {
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

  private async readAfterMutation(action: string, aliasId: string): Promise<CaddyAliasesState> {
    try {
      return await this.read()
    } catch (error: unknown) {
      throw new CaddyError(`Caddy alias '${aliasId}' ${action} could not be verified after configuration mutation.`, {
        code: CaddyErrorCode.CONFIGURATION_MISMATCH,
        outcome: CaddyMutationOutcome.UNKNOWN,
        details: {
          action,
          aliasId,
          error: caddyErrorDetailsFromUnknown(error),
        },
      })
    }
  }

  private assertExpectedAliases(
    observedState: CaddyAliasesState,
    expectedAliases: readonly ExpectedAlias[],
    action: string,
    aliasId: string,
  ): void {
    if (observedState.aliases.length !== expectedAliases.length) {
      this.throwConfigurationMismatch(action, aliasId, {
        expectedAliasCount: expectedAliases.length,
        actualAliasCount: observedState.aliases.length,
      })
    }
    for (const [index, expectedAlias] of expectedAliases.entries()) {
      const observedAlias = observedState.aliases[index]
      if (!observedAlias) {
        this.throwConfigurationMismatch(action, aliasId, {
          index,
          expectedAliasId: expectedAlias.id,
          actualAliasId: null,
        })
      }
      if (
        observedAlias.id !== expectedAlias.id ||
        observedAlias.index !== index ||
        !areJsonValuesEqual(observedAlias.route, expectedAlias.route)
      ) {
        this.throwConfigurationMismatch(action, aliasId, {
          index,
          expectedAliasId: expectedAlias.id,
          actualAliasId: observedAlias.id,
          expectedRouteIndex: index,
          actualRouteIndex: observedAlias.index,
        })
      }
    }
  }

  private throwConfigurationMismatch(action: string, aliasId: string, details: Record<string, unknown>): never {
    throw new CaddyError(`Caddy alias '${aliasId}' ${action} readback did not match the expected route table.`, {
      code: CaddyErrorCode.CONFIGURATION_MISMATCH,
      outcome: CaddyMutationOutcome.UNKNOWN,
      details: {
        action,
        aliasId,
        ...details,
      },
    })
  }

  private parseAliasRoute(value: unknown, context: string): CaddyAliasRoute {
    const parsed = CaddyAliasRouteSchema.safeParse(value)
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

  private parseAliasId(value: unknown): string {
    const parsed = CaddyAliasRouteIdSchema.safeParse(value)
    if (!parsed.success) {
      throw new CaddyError('Invalid Caddy alias route ID.', {
        code: CaddyErrorCode.VALIDATION_ERROR,
        outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
        details: {
          validation: z.treeifyError(parsed.error),
        },
      })
    }
    return parsed.data
  }

  private parseState(value: unknown, context: string): CaddyAliasesState {
    const parsed = CaddyAliasesStateSchema.safeParse(value)
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

  private expectedAliasesFromState(state: CaddyAliasesState): ExpectedAlias[] {
    return state.aliases.map(alias => ({
      id: alias.id,
      route: alias.route,
    }))
  }

  private findAlias(state: CaddyAliasesState, aliasId: string): CaddyAliasRouteEntry | undefined {
    return state.aliases.find(alias => alias.id === aliasId)
  }

  private routePositionPath(index: number): string {
    return `${this.routeTablePath}/${index}`
  }
}
