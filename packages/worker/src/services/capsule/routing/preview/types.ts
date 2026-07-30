import type {
  CapsuleBranchPreviewStatus,
  CapsuleBranchStatus,
  CapsuleLifecycleStatusValue,
  CapsuleRouteApplicationPin,
  CapsuleRouteConfigurationDigest,
  CapsuleRouteConfigurationKey,
  CapsuleRouteVerificationEvidence,
} from '@qiln/core/server'
import type { CaddyPreviewRoute } from '../../../../caddy'

export interface PreviewBranch {
  id: string
  ownerId: string
  capsuleId: string
  name: string
  status: CapsuleBranchStatus
  runtimeIp: string | null
  lifecycleStatus: CapsuleLifecycleStatusValue
  archivedAt: Date | null
  operationBlocked: boolean
}

export interface PreviewRecord {
  id: string
  ownerId: string
  capsuleId: string
  branchId: string
  applicationName: string
  applicationPin: CapsuleRouteApplicationPin
  host: string
  providerRouteId: string
  status: CapsuleBranchPreviewStatus
  withdrawalRequestedAt: Date | null
  currentRuntimeIp: string | null
  currentConfigurationKey: CapsuleRouteConfigurationKey | null
  currentConfigurationDigest: CapsuleRouteConfigurationDigest | null
  currentConfiguration: Record<string, unknown> | null
  pendingRuntimeIp: string | null
  pendingConfigurationKey: CapsuleRouteConfigurationKey | null
  pendingConfigurationDigest: CapsuleRouteConfigurationDigest | null
  pendingConfiguration: Record<string, unknown> | null
  applyIntentAt: Date | null
  appliedAt: Date | null
  verificationIntentAt: Date | null
  verificationEvidence: CapsuleRouteVerificationEvidence | null
  verifiedAt: Date | null
  removeIntentAt: Date | null
  failureCode: string | null
  failureMessage: string | null
  failureDetails: Record<string, unknown> | null
  failureAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface PreviewIdentity {
  host: string
  providerRouteId: string
}

export interface PreviewPlan {
  previewId: string
  ownerId: string
  capsuleId: string
  branchId: string
  applicationName: string
  application: CapsuleRouteApplicationPin
  host: string
  providerRouteId: string
  runtimeIp: string
  port: number
  verificationMethod: 'GET' | 'HEAD'
  verificationPath: string
  expectedStatuses: readonly number[]
  route: CaddyPreviewRoute
  configurationKey: CapsuleRouteConfigurationKey
  configurationDigest: CapsuleRouteConfigurationDigest
  configuration: Record<string, unknown>
}
