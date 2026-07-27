import type {
  CapsuleBlueprintDigest,
  CapsuleBlueprintPin,
  CapsuleOperationStatusValue,
  CapsuleOperationTypeValue,
  CapsuleRouteAliasName,
  CapsuleRouteAliasStatus,
  CapsuleRouteConfigurationDigest,
  CapsuleRouteConfigurationKey,
  CapsuleRouteEvidencePin,
  CapsuleRouteExposure,
  CapsuleRouteMethod,
  CapsuleRouteProvider,
  CapsuleRouteProviderStatus,
  CapsuleRouteRevisionAction,
  CapsuleRouteRevisionStatus,
  CapsuleRouteTargetPin,
  CapsuleRouteVerificationEvidence,
  CapsuleSnapshotLimitationValue,
  CapsuleSnapshotModeValue,
} from '@qiln/core/server'

export interface RouteCapsuleRecord {
  id: string
  ownerId: string
}

export interface RouteAliasRecord {
  id: string
  ownerId: string
  capsuleId: string
  name: CapsuleRouteAliasName
  exposure: CapsuleRouteExposure
  host: string
  path: string
  methods: CapsuleRouteMethod[]
  matcherDigest: string
  status: CapsuleRouteAliasStatus
  createdAt: Date
  updatedAt: Date
}

export interface RouteHeadRecord {
  aliasId: string
  revisionId: string
}

export interface RouteRevisionRecord {
  id: string
  aliasId: string
  number: number
  action: CapsuleRouteRevisionAction
  previousRevisionId: string | null
  rollbackSourceRevisionId: string | null
  snapshotId: string
  targetPin: CapsuleRouteTargetPin
  evidencePin: CapsuleRouteEvidencePin
  operationId: string
  status: CapsuleRouteRevisionStatus
  committedAt: Date | null
  failedAt: Date | null
}

export interface RouteOperationRecord {
  id: string
  ownerId: string
  capsuleId: string
  type: CapsuleOperationTypeValue
  status: CapsuleOperationStatusValue
  providerMutationStartedAt: Date | null
  completedAt: Date | null
}

export interface RouteOperationExtensionRecord {
  operationId: string
  aliasId: string
  action: CapsuleRouteRevisionAction
  expectedRevisionId: string | null
  proposedRevisionId: string
  rollbackSourceRevisionId: string | null
}

export interface RouteProviderRecord {
  operationId: string
  revisionId: string
  provider: CapsuleRouteProvider
  status: CapsuleRouteProviderStatus
  configurationKey: CapsuleRouteConfigurationKey | null
  configurationDigest: CapsuleRouteConfigurationDigest | null
  configuration: Record<string, unknown> | null
  applyIntentAt: Date | null
  appliedAt: Date | null
  verificationIntentAt: Date | null
  verificationEvidence: unknown
  verifiedAt: Date | null
  failureCode: string | null
  failureMessage: string | null
  failureDetails: Record<string, unknown> | null
  failureAt: Date | null
}

export interface RouteSnapshotRecord {
  id: string
  capsuleId: string
  blueprintSchemaVersion: number
  blueprintName: string
  blueprintDigest: CapsuleBlueprintDigest
  blueprintPin: CapsuleBlueprintPin
  mode: CapsuleSnapshotModeValue
  limitations: CapsuleSnapshotLimitationValue[]
}

export interface RouteGraphRow {
  capsule: RouteCapsuleRecord
  alias: RouteAliasRecord
  head: RouteHeadRecord | null
  revision: RouteRevisionRecord | null
  operation: RouteOperationRecord | null
  extension: RouteOperationExtensionRecord | null
  provider: RouteProviderRecord | null
  snapshot: RouteSnapshotRecord | null
}

export interface CommittedRouteRevisionRecord extends RouteRevisionRecord {
  status: 'committed'
  committedAt: Date
  failedAt: null
}

export interface CompletedRouteOperationRecord extends RouteOperationRecord {
  status: 'completed'
  providerMutationStartedAt: Date
  completedAt: Date
}

export interface VerifiedRouteProviderRecord extends RouteProviderRecord {
  status: 'verified'
  configurationKey: CapsuleRouteConfigurationKey
  configurationDigest: CapsuleRouteConfigurationDigest
  configuration: Record<string, unknown>
  applyIntentAt: Date
  appliedAt: Date
  verificationIntentAt: Date
  verificationEvidence: CapsuleRouteVerificationEvidence
  verifiedAt: Date
  failureCode: null
  failureMessage: null
  failureDetails: null
  failureAt: null
}

export interface HeadlessRouteRecord {
  alias: RouteAliasRecord
  head: null
  revision: null
  operation: null
  extension: null
  provider: null
  snapshot: null
}

export interface HeadedRouteRecord {
  alias: RouteAliasRecord
  head: RouteHeadRecord
  revision: CommittedRouteRevisionRecord
  operation: CompletedRouteOperationRecord
  extension: RouteOperationExtensionRecord
  provider: VerifiedRouteProviderRecord
  snapshot: RouteSnapshotRecord
}

export type CommittedRouteRecord = HeadlessRouteRecord | HeadedRouteRecord

export interface CommittedRouteState {
  capsuleId: string
  aliasId: string
  aliasName: CapsuleRouteAliasName
  aliasStatus: CapsuleRouteAliasStatus
  currentRevisionId: string | null
}
