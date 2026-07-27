import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  CapsuleRouteConfigurationDigestSchema,
  CapsuleRouteConfigurationKeySchema,
  CapsuleRouteProvider,
  CapsuleRouteProviderStatus,
  CapsuleRouteRevisionStatus,
  CapsuleRouteVerificationEvidenceSchema,
  digestCapsuleRouteConfiguration,
} from '@qiln/core/server'
import { IncusError } from '../../../errors'
import type { CommittedRouteRecord, RouteGraphRow, RouteProviderRecord, RouteRevisionRecord } from './types'

function integrity(row: RouteGraphRow, message: string, details: Record<string, unknown> = {}): never {
  throw new IncusError(message, 'API_ERROR', {
    capsuleId: row.capsule.id,
    aliasId: row.alias.id,
    ...details,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOrdered(first: Date, second: Date): boolean {
  return first.getTime() <= second.getTime()
}

function typeFor(revision: RouteRevisionRecord) {
  return revision.action === 'promote' ? CapsuleOperationType.PROMOTE : CapsuleOperationType.ROLLBACK
}

function verifyProvider(row: RouteGraphRow, provider: RouteProviderRecord) {
  if (provider.provider !== CapsuleRouteProvider.CADDY || provider.status !== CapsuleRouteProviderStatus.VERIFIED) {
    integrity(row, 'Committed route provider application is not verified.', {
      operationId: provider.operationId,
      revisionId: provider.revisionId,
      provider: provider.provider,
      providerStatus: provider.status,
    })
  }
  if (
    provider.configurationKey === null ||
    provider.configurationDigest === null ||
    provider.configuration === null ||
    provider.applyIntentAt === null ||
    provider.appliedAt === null ||
    provider.verificationIntentAt === null ||
    provider.verificationEvidence === null ||
    provider.verifiedAt === null
  ) {
    integrity(row, 'Committed route provider application is missing verified configuration evidence.', {
      operationId: provider.operationId,
      revisionId: provider.revisionId,
    })
  }
  if (
    provider.failureCode !== null ||
    provider.failureMessage !== null ||
    provider.failureDetails !== null ||
    provider.failureAt !== null
  ) {
    integrity(row, 'Verified route provider application contains contradictory failure evidence.', {
      operationId: provider.operationId,
      revisionId: provider.revisionId,
    })
  }
  const key = CapsuleRouteConfigurationKeySchema.safeParse(provider.configurationKey)
  const digest = CapsuleRouteConfigurationDigestSchema.safeParse(provider.configurationDigest)
  const evidence = CapsuleRouteVerificationEvidenceSchema.safeParse(provider.verificationEvidence)
  if (!key.success || !digest.success || !evidence.success || !isRecord(provider.configuration)) {
    integrity(row, 'Committed route provider configuration evidence failed validation.', {
      operationId: provider.operationId,
      revisionId: provider.revisionId,
    })
  }
  let actualDigest: typeof digest.data
  try {
    actualDigest = digestCapsuleRouteConfiguration(provider.configuration)
  } catch (error: unknown) {
    integrity(row, 'Committed route provider configuration cannot be canonicalized.', {
      operationId: provider.operationId,
      revisionId: provider.revisionId,
      cause: error instanceof Error ? error.message : 'Unknown configuration digest failure',
    })
  }
  if (actualDigest !== digest.data || evidence.data.configurationDigest !== digest.data) {
    integrity(row, 'Committed route provider configuration does not match its verification evidence.', {
      operationId: provider.operationId,
      revisionId: provider.revisionId,
      expectedDigest: digest.data,
      actualDigest,
      verificationDigest: evidence.data.configurationDigest,
    })
  }
  if (!evidence.data.upstreamVerified || !evidence.data.routeVerified) {
    integrity(row, 'Committed route provider verification did not positively verify the upstream and route.', {
      operationId: provider.operationId,
      revisionId: provider.revisionId,
      upstreamVerified: evidence.data.upstreamVerified,
      routeVerified: evidence.data.routeVerified,
    })
  }
  if (
    !isOrdered(provider.applyIntentAt, provider.appliedAt) ||
    !isOrdered(provider.appliedAt, provider.verificationIntentAt) ||
    !isOrdered(provider.verificationIntentAt, provider.verifiedAt) ||
    new Date(evidence.data.verifiedAt).getTime() !== provider.verifiedAt.getTime()
  ) {
    integrity(row, 'Committed route provider timestamps are inconsistent.', {
      operationId: provider.operationId,
      revisionId: provider.revisionId,
    })
  }
  return {
    ...provider,
    status: CapsuleRouteProviderStatus.VERIFIED,
    configurationKey: key.data,
    configurationDigest: digest.data,
    configuration: provider.configuration,
    applyIntentAt: provider.applyIntentAt,
    appliedAt: provider.appliedAt,
    verificationIntentAt: provider.verificationIntentAt,
    verificationEvidence: evidence.data,
    verifiedAt: provider.verifiedAt,
    failureCode: null,
    failureMessage: null,
    failureDetails: null,
    failureAt: null,
  } as const
}

/**
 * Validates one alias projection as either headless committed state or a
 * complete committed operation, revision, provider, and snapshot graph.
 *
 * Provider verification supplements the alias head. It never creates route
 * authority independently from the committed revision selected by that head.
 */
export function validate(row: RouteGraphRow): CommittedRouteRecord {
  if (row.alias.ownerId !== row.capsule.ownerId || row.alias.capsuleId !== row.capsule.id) {
    integrity(row, 'Route alias ownership does not match its capsule aggregate.', {
      capsuleOwnerId: row.capsule.ownerId,
      aliasOwnerId: row.alias.ownerId,
      aliasCapsuleId: row.alias.capsuleId,
    })
  }
  if (row.head === null) {
    if (
      row.revision !== null ||
      row.operation !== null ||
      row.extension !== null ||
      row.provider !== null ||
      row.snapshot !== null
    ) {
      integrity(row, 'Headless route alias contains a partial committed target graph.')
    }
    return {
      alias: row.alias,
      head: null,
      revision: null,
      operation: null,
      extension: null,
      provider: null,
      snapshot: null,
    }
  }
  const revision = row.revision
  const operation = row.operation
  const extension = row.extension
  const provider = row.provider
  const snapshot = row.snapshot
  if (!revision || !operation || !extension || !provider || !snapshot) {
    integrity(row, 'Route alias head does not resolve a complete committed route graph.', {
      revisionPresent: revision !== null,
      operationPresent: operation !== null,
      extensionPresent: extension !== null,
      providerPresent: provider !== null,
      snapshotPresent: snapshot !== null,
    })
  }
  if (row.head.aliasId !== row.alias.id || row.head.revisionId !== revision.id || revision.aliasId !== row.alias.id) {
    integrity(row, 'Route alias head and committed revision identities disagree.', {
      headAliasId: row.head.aliasId,
      headRevisionId: row.head.revisionId,
      revisionId: revision.id,
      revisionAliasId: revision.aliasId,
    })
  }
  if (
    revision.status !== CapsuleRouteRevisionStatus.COMMITTED ||
    revision.committedAt === null ||
    revision.failedAt !== null
  ) {
    integrity(row, 'Route alias head does not identify a committed revision.', {
      revisionId: revision.id,
      revisionStatus: revision.status,
      committedAtPresent: revision.committedAt !== null,
      failedAtPresent: revision.failedAt !== null,
    })
  }
  if (
    operation.id !== revision.operationId ||
    operation.ownerId !== row.alias.ownerId ||
    operation.capsuleId !== row.alias.capsuleId ||
    operation.type !== typeFor(revision) ||
    operation.status !== CapsuleOperationStatus.COMPLETED ||
    operation.providerMutationStartedAt === null ||
    operation.completedAt === null
  ) {
    integrity(row, 'Committed route revision does not match a completed route operation.', {
      revisionId: revision.id,
      revisionAction: revision.action,
      revisionOperationId: revision.operationId,
      operationId: operation.id,
      operationType: operation.type,
      operationStatus: operation.status,
      providerIntentPresent: operation.providerMutationStartedAt !== null,
      completedAtPresent: operation.completedAt !== null,
    })
  }
  if (
    extension.operationId !== operation.id ||
    extension.aliasId !== row.alias.id ||
    extension.action !== revision.action ||
    extension.proposedRevisionId !== revision.id ||
    extension.expectedRevisionId !== revision.previousRevisionId ||
    extension.rollbackSourceRevisionId !== revision.rollbackSourceRevisionId
  ) {
    integrity(row, 'Committed route operation extension disagrees with its revision.', {
      operationId: operation.id,
      revisionId: revision.id,
      extensionAliasId: extension.aliasId,
      extensionAction: extension.action,
      extensionProposedRevisionId: extension.proposedRevisionId,
    })
  }
  if (provider.operationId !== operation.id || provider.revisionId !== revision.id) {
    integrity(row, 'Committed route provider application disagrees with its operation and revision.', {
      operationId: operation.id,
      revisionId: revision.id,
      providerOperationId: provider.operationId,
      providerRevisionId: provider.revisionId,
    })
  }
  if (snapshot.id !== revision.snapshotId) {
    integrity(row, 'Committed route revision does not match its snapshot projection.', {
      revisionId: revision.id,
      revisionSnapshotId: revision.snapshotId,
      snapshotId: snapshot.id,
    })
  }
  const verifiedProvider = verifyProvider(row, provider)
  return {
    alias: row.alias,
    head: row.head,
    revision: {
      ...revision,
      status: CapsuleRouteRevisionStatus.COMMITTED,
      committedAt: revision.committedAt,
      failedAt: null,
    },
    operation: {
      ...operation,
      status: CapsuleOperationStatus.COMPLETED,
      providerMutationStartedAt: operation.providerMutationStartedAt,
      completedAt: operation.completedAt,
    },
    extension,
    provider: verifiedProvider,
    snapshot,
  }
}
