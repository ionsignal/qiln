import { digestCanonicalJsonValue } from '@qiln/core/server'
import type { CapsuleBranchResourceInventoryEntry } from '../../../resource/inventory'
import type { CreateResourceProof } from '../../../resource/provenance'
import type {
  DestroyBranch,
  DestroyFile,
  DestroyInstance,
  DestroyOperation,
  DestroyResource,
  DestroyVolume,
} from '../types'

export type AssessmentPhase = 'plan' | 'execution' | 'completion'

export type PlannedResource = CapsuleBranchResourceInventoryEntry & {
  metadata: Record<string, unknown>
}

export type BranchAssessment =
  | {
      kind: 'none'
      branchId: string
      missing: PlannedResource[]
    }
  | {
      kind: 'delete'
      branchId: string
      instances: DestroyInstance[]
      volumes: DestroyVolume[]
      files: DestroyFile[]
    }
  | {
      kind: 'cleanup'
      branchId: string
      reason: string
    }

export interface AssessmentInput {
  operation: DestroyOperation
  branch: DestroyBranch
  proof: CreateResourceProof
  resources: readonly DestroyResource[]
  phase: AssessmentPhase
  allowRepair: boolean
  allowedOperationIds: ReadonlySet<string>
}

function identity(resource: { provider?: string; resourceKey: string }): string {
  return `${resource.provider ?? 'incus'}\u0000${resource.resourceKey}`
 }

function entry(resource: DestroyResource): CapsuleBranchResourceInventoryEntry {
  return {
    provider: resource.provider,
    resourceType: resource.resourceType,
    resourceKey: resource.resourceKey,
    blueprintVolumeName: resource.blueprintVolumeName,
    cleanupPolicy: resource.cleanupPolicy,
    metadata: resource.metadata,
  }
}

function digest(value: CapsuleBranchResourceInventoryEntry): string {
  return digestCanonicalJsonValue(value, {
    context: 'destroy resource identity',
  })
}

function hasFailure(resource: DestroyResource): boolean {
  return (
    resource.failureCode !== null ||
    resource.failureMessage !== null ||
    resource.failureDetails !== null
  )
}

function validOrigin(operation: DestroyOperation): boolean {
  if (operation.status === 'completed') {
    return (
      operation.executionStartedAt !== null &&
      operation.providerMutationStartedAt !== null &&
      operation.completedAt !== null &&
      operation.failedAt === null &&
      operation.failureCode === null &&
      operation.failureMessage === null &&
      operation.failureDetails === null
    )
  }
  if (operation.status !== 'failed' && operation.status !== 'cleanup_required') {
    return false
  }
  return (
    operation.completedAt === null &&
    operation.failedAt !== null &&
    operation.failureCode !== null &&
    operation.failureMessage !== null &&
    (operation.providerMutationStartedAt === null || operation.executionStartedAt !== null)
  )
}

/**
 * Assesses resource obligations from immutable create provenance.
 *
 * Originating provider intent determines whether Incus resources may exist.
 * Destroy provider intent authorizes this destroy's mutations but cannot
 * establish resource existence.
 *
 * This policy performs no persistence, provider calls, repair, or scheduling.
 */
export function assessBranch(input: AssessmentInput): BranchAssessment {
  const { operation, branch, proof, resources, phase } = input
  const cleanup = (reason: string): BranchAssessment => ({
    kind: 'cleanup',
    branchId: branch.id,
    reason,
  })
  const origin = proof.origin
  if (
    origin.type !== 'create' ||
    origin.ownerId !== operation.ownerId ||
    origin.capsuleId !== operation.capsuleId ||
    branch.ownerId !== operation.ownerId ||
    branch.capsuleId !== operation.capsuleId ||
    proof.lineage.rootBranch.id !== branch.id ||
    !validOrigin(origin)
  ) {
    return cleanup('Originating create provenance is contradictory or nonterminal.')
  }
  if (!operation.destroyForce && origin.status !== 'completed') {
    return cleanup('Normal destroy requires completed create provenance.')
  }

  const expected = new Map(proof.inventory.map(resource => [identity(resource), resource]))
  if (expected.size !== proof.inventory.length) {
    return cleanup('Immutable create inventory contains duplicate identities.')
  }
  const actual = new Map<string, DestroyResource>()
  for (const resource of resources) {
    const key = identity(resource)
    const planned = expected.get(key)
    if (
      !planned ||
      actual.has(key) ||
      resource.ownerId !== operation.ownerId ||
      resource.branchId !== branch.id ||
      resource.branchName !== branch.name ||
      resource.createdByOperationId !== origin.id ||
      resource.lastOperationId === null ||
      !input.allowedOperationIds.has(resource.lastOperationId) ||
      digest(entry(resource)) !== digest(planned)
    ) {
      return cleanup('Resource ownership, provenance, or immutable identity does not match the create plan.')
    }
    actual.set(key, resource)
  }

  const originHasProviderIntent = origin.providerMutationStartedAt !== null
  const missing = proof.inventory.filter(resource => !actual.has(identity(resource)))
  if (proof.recordedInventoryDigest === null) {
    if (!operation.destroyForce || originHasProviderIntent || resources.length !== 0) {
      return cleanup('Resource inventory has no recorded digest supporting its provider obligations.')
    }
    return {
      kind: 'none',
      branchId: branch.id,
      missing: [],
    }
  }

  if (!originHasProviderIntent) {
    if (!operation.destroyForce) {
      return cleanup('Normal destroy requires originating provider intent.')
    }
    if (
      resources.some(
        resource =>
          resource.status !== 'planned' ||
          resource.lastOperationId !== origin.id ||
          hasFailure(resource),
      )
    ) {
      return cleanup('Resource execution evidence exists without originating provider intent.')
    }
    if (missing.length > 0 && !input.allowRepair) {
      return cleanup('Untouched resource inventory is incomplete.')
    }
    return {
      kind: 'none',
      branchId: branch.id,
      missing,
    }
  }

  if (missing.length > 0) {
    return cleanup('Provider-intent inventory is incomplete; missing identities cannot be repaired as planned.')
  }

  for (const resource of resources) {
    const retained =
      resource.resourceType === 'incus_project' || resource.resourceType === 'bind_mount'
    if (!operation.destroyForce && retained && (resource.status !== 'adopted' || hasFailure(resource))) {
      return cleanup('Normal destroy requires clean retained and external resource accounting.')
    }
    if (
      !operation.destroyForce &&
      phase === 'plan' &&
      !retained &&
      (resource.status !== 'created' || resource.lastOperationId !== origin.id || hasFailure(resource))
    ) {
      return cleanup('Normal destroy requires clean create-owned managed resources.')
    }
    if (!operation.destroyForce && phase === 'execution' && !retained) {
      const untouched =
        resource.status === 'created' && resource.lastOperationId === origin.id && !hasFailure(resource)
      const destroying =
        resource.lastOperationId === operation.id &&
        ['deleting', 'deleted', 'missing', 'error'].includes(resource.status)
      if (!untouched && !destroying) {
        return cleanup('Managed resource accounting does not belong to this normal destroy.')
      }
    }
    if (phase === 'completion' && !retained) {
      const terminal =
        resource.resourceType === 'provisioning_file'
          ? resource.status === 'deleted'
          : resource.status === 'deleted' || resource.status === 'missing'
      if (!terminal || resource.lastOperationId !== operation.id || hasFailure(resource)) {
        return cleanup('Managed resource lacks a clean terminal outcome committed by this destroy.')
      }
    }
  }

  const instanceRow = actual.get(identity(proof.plan.instance))
  if (!instanceRow) {
    return cleanup('Managed instance identity is missing.')
  }
  const instance: DestroyInstance = {
    kind: 'instance',
    id: instanceRow.id,
    branchId: branch.id,
    branchName: branch.name,
    resourceKey: instanceRow.resourceKey,
    namespace: proof.plan.project.namespace,
    instanceName: proof.plan.instance.instanceName,
  }
  const volumes: DestroyVolume[] = []
  for (const volume of proof.plan.volumes) {
    const row = actual.get(identity(volume))
    if (!row) {
      return cleanup('Managed volume identity is missing.')
    }
    volumes.push({
      kind: 'volume',
      id: row.id,
      branchId: branch.id,
      branchName: branch.name,
      resourceKey: row.resourceKey,
      namespace: proof.plan.project.namespace,
      pool: volume.pool,
      volumeName: volume.volumeName,
    })
  }
  const files: DestroyFile[] = []
  for (const file of proof.plan.files) {
    const row = actual.get(identity(file))
    const target = file.target
    const backing =
      target.target === 'instance'
        ? instance
        : volumes.find(volume => volume.pool === target.pool && volume.volumeName === target.volumeName)
    if (!row || !backing) {
      return cleanup('Provisioning file has no proven managed backing resource.')
    }
    files.push({
      id: row.id,
      branchId: branch.id,
      backingResourceId: backing.id,
    })
  }
  return {
    kind: 'delete',
    branchId: branch.id,
    instances: [instance],
    volumes,
    files,
  }
}
