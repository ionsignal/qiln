import {
  CapsuleRouteHostSchema,
  createCapsuleBlueprintReference,
  createCapsuleRouteApplicationPin,
  digestCapsuleRouteConfiguration,
  verifyCapsuleRouteApplicationPin,
  type CapsuleDestroyResourcePlan,
} from '@qiln/core/server'
import { CaddyExactRouteIdSchema } from '../../../../../caddy'
import { IncusError } from '../../../../../errors'
import { previewRouteId } from '../../../routing/preview/host'
import type {
  DestroyAlias,
  DestroyBranchProof,
  DestroyOperation,
  DestroyPreview,
  DestroyRevision,
  DestroyRouteOperation,
  DestroyRouteProvider,
} from '../types'

export interface RouteProofInput {
  ownerId: string
  capsuleId: string
  server: string
  branches: ReadonlyMap<string, DestroyBranchProof>
  operations: ReadonlyMap<string, DestroyOperation>
  previews: readonly DestroyPreview[]
  aliases: readonly DestroyAlias[]
  revisions: readonly DestroyRevision[]
  extensions: readonly DestroyRouteOperation[]
  providers: readonly DestroyRouteProvider[]
  heads: readonly { aliasId: string; revisionId: string }[]
}

/**
 * Hostnames are historical configuration. Only the stable route ID is derived
 * during preview deletion; allocation's current base domain is irrelevant.
 */
export function routeTargets(input: RouteProofInput): CapsuleDestroyResourcePlan[] {
  const result: CapsuleDestroyResourcePlan[] = []
  for (const preview of input.previews) {
    const branch = input.branches.get(preview.branchId)
    const application = verifyCapsuleRouteApplicationPin(preview.applicationPin)
    const historical = branch?.blueprint.blueprint.applications.find(
      candidate => candidate.name === preview.applicationName,
    )
    if (
      !branch ||
      !historical ||
      preview.ownerId !== input.ownerId ||
      preview.capsuleId !== input.capsuleId ||
      application.application.name !== preview.applicationName ||
      preview.providerRouteId !== previewRouteId(preview.branchId, preview.applicationName) ||
      !CapsuleRouteHostSchema.safeParse(preview.host).success
    ) {
      throw new IncusError('Preview deletion identity is not bound to an owned historical branch application.', 'CONFLICT', {
        previewId: preview.id,
      })
    }
    const expected = createCapsuleRouteApplicationPin({
      schemaVersion: 1,
      blueprint: createCapsuleBlueprintReference(branch.blueprint),
      application: historical,
    })
    if (expected.digest !== application.digest) {
      throw new IncusError('Preview application evidence disagrees with branch provenance.', 'CONFLICT', {
        previewId: preview.id,
      })
    }
    result.push({
      target: {
        kind: 'route',
        provider: 'caddy',
        server: input.server,
        routeId: preview.providerRouteId,
      },
      proof: {
        source: 'preview',
        previewId: preview.id,
        branchId: preview.branchId,
        applicationName: preview.applicationName,
        applicationDigest: application.digest,
      },
    })
  }
  const visitedProviders = new Set<string>()
  for (const alias of input.aliases) {
    if (alias.ownerId !== input.ownerId || alias.capsuleId !== input.capsuleId) {
      throw new IncusError('Route alias deletion has contradictory ownership.', 'CONFLICT', {
        aliasId: alias.id,
      })
    }
    const revisions = input.revisions.filter(revision => revision.aliasId === alias.id)
    const ids = new Set<string>()
    for (const revision of revisions) {
      const operation = input.operations.get(revision.operationId)
      const extension = input.extensions.find(candidate => candidate.operationId === revision.operationId)
      const provider = input.providers.find(candidate => candidate.operationId === revision.operationId)
      if (
        !operation ||
        operation.ownerId !== input.ownerId ||
        operation.capsuleId !== input.capsuleId ||
        operation.type !== revision.action ||
        !extension ||
        extension.aliasId !== alias.id ||
        extension.proposedRevisionId !== revision.id ||
        extension.action !== revision.action
      ) {
        throw new IncusError('Route deletion cannot prove its operation and revision binding.', 'CONFLICT', {
          aliasId: alias.id,
          revisionId: revision.id,
        })
      }
      if (!provider || provider.configuration === null) {
        if (
          operation.providerMutationStartedAt !== null ||
          revision.status === 'committed' ||
          provider?.applyIntentAt != null
        ) {
          throw new IncusError('Route provider intent has no durable exact route identity.', 'CONFLICT', {
            aliasId: alias.id,
            revisionId: revision.id,
          })
        }
        if (provider) {
          visitedProviders.add(provider.operationId)
        }
        continue
      }
      if (
        provider.revisionId !== revision.id ||
        provider.provider !== 'caddy' ||
        provider.configurationDigest === null ||
        digestCapsuleRouteConfiguration(provider.configuration) !== provider.configurationDigest
      ) {
        throw new IncusError('Route deletion configuration evidence is contradictory.', 'CONFLICT', {
          aliasId: alias.id,
          revisionId: revision.id,
        })
      }
      const id = CaddyExactRouteIdSchema.safeParse(provider.configuration['@id'])
      if (!id.success) {
        throw new IncusError('Route deletion lacks a supported durably bound provider route ID.', 'CONFLICT', {
          aliasId: alias.id,
          revisionId: revision.id,
        })
      }
      ids.add(id.data)
      visitedProviders.add(provider.operationId)
    }
    const head = input.heads.find(candidate => candidate.aliasId === alias.id)
    if (head && !revisions.some(revision => revision.id === head.revisionId)) {
      throw new IncusError('Route alias head references missing historical evidence.', 'CONFLICT', {
        aliasId: alias.id,
      })
    }
    const requiresExactRouteIdentity =
      head !== undefined ||
      alias.status === 'active' ||
      alias.status === 'mutating' ||
      (alias.status === 'cleanup_required' && alias.mutationOperationId !== null)
    // A prior destroy can classify a headless alias as cleanup-required after
    // clearing its mutation fence. That status alone does not prove Caddy ever
    // received a route configuration to withdraw.
    if (ids.size === 0 && requiresExactRouteIdentity) {
      const mutation = alias.mutationOperationId === null
        ? undefined
        : input.operations.get(alias.mutationOperationId)
      if (!mutation || mutation.providerMutationStartedAt !== null || revisions.length === 0) {
        throw new IncusError('Unresolved route alias has no exact provider identity for withdrawal.', 'CONFLICT', {
          aliasId: alias.id,
        })
      }
    }
    for (const routeId of ids) {
      result.push({
        target: {
          kind: 'route',
          provider: 'caddy',
          server: input.server,
          routeId,
        },
        proof: {
          source: 'alias',
          aliasId: alias.id,
        },
      })
    }
  }
  if (
    input.providers.some(provider => !visitedProviders.has(provider.operationId)) ||
    input.revisions.some(revision => !input.aliases.some(alias => alias.id === revision.aliasId)) ||
    input.extensions.some(extension =>
      !input.revisions.some(revision =>
        revision.id === extension.proposedRevisionId &&
        revision.operationId === extension.operationId &&
        revision.aliasId === extension.aliasId,
      ),
    )
  ) {
    throw new IncusError('Route deletion cannot prove complete historical provider coverage.', 'CONFLICT')
  }
  return result
}
