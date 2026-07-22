import { IncusError } from '../../../../errors'
import { CreateCapsuleStepKey } from './stepKeys'
import { createCreateCapsuleFailureContext } from './failureContext'
import type { CreateCapsuleExecutionState } from './executionState'
import type {
  CreateCapsuleBindMountResource,
  CreateCapsuleInstanceResource,
  CreateCapsuleOperationContext,
  CreateCapsuleProjectResource,
  CreateCapsuleProvisioningFileResource,
  CreateCapsuleVolumeResource,
} from './types'
import type { CapsuleResourceDriver } from '../../resource/driver'
import type { CapsuleBranchResourceStore } from '../../resource/store'
import type { BranchResourceInput } from '../../resource/types'

export interface CreateCapsuleResourceProvisioningDependencies {
  resources: CapsuleBranchResourceStore
  driver: CapsuleResourceDriver
}

type CreateCapsuleDirectResourceMutationStep =
  typeof CreateCapsuleStepKey.CREATE_VOLUMES | typeof CreateCapsuleStepKey.CREATE_INSTANCE

/**
 * Ensures the owner-scoped provider namespace and records that the namespace is
 * an adopted, retained resource.
 *
 * Namespace creation is idempotent at the provider boundary, but a failed
 * provider response cannot prove whether creation reached Incus. That outcome
 * therefore makes provider ownership uncertain for this create attempt.
 */
export async function ensureOwnerNamespace(
  dependencies: CreateCapsuleResourceProvisioningDependencies,
  context: CreateCapsuleOperationContext,
  project: CreateCapsuleProjectResource,
  state: CreateCapsuleExecutionState,
): Promise<void> {
  const resourceId = await dependencies.resources.ensureBranchResource(createBranchResourceInput(context, project))

  try {
    await dependencies.driver.ensureNamespace(context.ownerId)
    await dependencies.resources.recordBranchResourceAdoption(resourceId, context.operationId)
  } catch (error: unknown) {
    // Namespace creation may have reached Incus even when the response is unknown.
    state.markProviderOwnershipUncertain()

    await markResourceErrorBestEffort(dependencies.resources, resourceId, error, {
      operationId: context.operationId,
      capsuleId: context.capsuleId,
      rootBranchId: context.rootBranchId,
      rootBranchName: context.rootBranchName,
      phase: CreateCapsuleStepKey.ENSURE_NAMESPACE,
      stepKey: CreateCapsuleStepKey.ENSURE_NAMESPACE,
      action: 'ensure_namespace',
      resourceId,
      resourceKey: project.resourceKey,
      providerIntentCommitted: state.providerIntentCommitted,
      providerOwnershipUncertain: true,
    })

    throw error
  }
}

/**
 * Records external bind mounts in the durable branch resource inventory.
 *
 * Bind mounts are adopted external resources. Qiln records their identity for
 * audit and complete inventory verification but never treats them as direct
 * provider resources eligible for create compensation or branch deletion.
 */
export async function recordExternalBindMounts(
  dependencies: CreateCapsuleResourceProvisioningDependencies,
  context: CreateCapsuleOperationContext,
  bindMounts: readonly CreateCapsuleBindMountResource[],
): Promise<void> {
  for (const bindMount of bindMounts) {
    const resourceId = await dependencies.resources.ensureBranchResource(createBranchResourceInput(context, bindMount))
    await dependencies.resources.recordBranchResourceAdoption(resourceId, context.operationId)
  }
}

/**
 * Creates every managed branch volume in deterministic plan order.
 *
 * Each provider call is fenced by a per-resource create-intent transition. A
 * volume enters the process-local compensation scope only after both provider
 * creation and its durable create outcome have completed successfully.
 */
export async function createManagedVolumes(
  dependencies: CreateCapsuleResourceProvisioningDependencies,
  context: CreateCapsuleOperationContext,
  volumes: readonly CreateCapsuleVolumeResource[],
  state: CreateCapsuleExecutionState,
): Promise<void> {
  for (const volume of volumes) {
    const resourceId = await dependencies.resources.ensureBranchResource(createBranchResourceInput(context, volume))
    let providerMutationAttempted = false

    try {
      await dependencies.resources.recordBranchResourceCreateIntent(resourceId, context.operationId)
      providerMutationAttempted = true

      await dependencies.driver.createVolume(context.namespace, volume)
      await dependencies.resources.recordBranchResourceCreateOutcome(resourceId, context.operationId)

      state.compensation.recordCreatedVolume(resourceId, volume)
    } catch (error: unknown) {
      if (providerMutationAttempted) {
        state.markProviderOwnershipUncertain()

        await recordDirectResourceCreateFailureBestEffort(
          dependencies.resources,
          context,
          resourceId,
          volume.resourceKey,
          CreateCapsuleStepKey.CREATE_VOLUMES,
          'create_volume',
          error,
          state,
        )
      }

      throw error
    }
  }
}

/**
 * Creates the root branch instance after all managed volumes have been created.
 *
 * The instance enters the compensation scope only after its successful provider
 * creation has also been durably recorded.
 */
export async function createRootBranchInstance(
  dependencies: CreateCapsuleResourceProvisioningDependencies,
  context: CreateCapsuleOperationContext,
  instance: CreateCapsuleInstanceResource,
  state: CreateCapsuleExecutionState,
): Promise<void> {
  const resourceId = await dependencies.resources.ensureBranchResource(createBranchResourceInput(context, instance))
  let providerMutationAttempted = false

  try {
    await dependencies.resources.recordBranchResourceCreateIntent(resourceId, context.operationId)
    providerMutationAttempted = true

    await dependencies.driver.createInstance(context.namespace, instance)
    await dependencies.resources.recordBranchResourceCreateOutcome(resourceId, context.operationId)

    state.compensation.recordCreatedInstance(resourceId, instance.resourceKey, instance.instanceName)
  } catch (error: unknown) {
    if (providerMutationAttempted) {
      state.markProviderOwnershipUncertain()

      await recordDirectResourceCreateFailureBestEffort(
        dependencies.resources,
        context,
        resourceId,
        instance.resourceKey,
        CreateCapsuleStepKey.CREATE_INSTANCE,
        'create_instance',
        error,
        state,
      )
    }

    throw error
  }
}

/**
 * Writes planned provisioning files after the instance and all managed volumes
 * have been created and durably recorded.
 *
 * Provisioning files are derived resources. Their compensation eligibility is
 * tied to a proven direct backing resource rather than to independent provider
 * deletion.
 */
export async function writeProvisioningFiles(
  dependencies: CreateCapsuleResourceProvisioningDependencies,
  context: CreateCapsuleOperationContext,
  files: readonly CreateCapsuleProvisioningFileResource[],
  state: CreateCapsuleExecutionState,
): Promise<void> {
  const instanceResourceId = state.compensation.getCreatedInstanceResourceId()

  if (!instanceResourceId) {
    throw new IncusError(
      'Capsule root instance ownership was not durably recorded before provisioning files.',
      'API_ERROR',
      {
        operationId: context.operationId,
        capsuleId: context.capsuleId,
        rootBranchId: context.rootBranchId,
      },
    )
  }

  for (const file of files) {
    const resourceId = await dependencies.resources.ensureBranchResource(createBranchResourceInput(context, file))
    const backingResourceId = resolveProvisioningFileBackingResourceId(file, instanceResourceId, state)

    state.compensation.recordDerivedProvisioningFile({
      resourceId,
      resourceKey: file.resourceKey,
      backingResourceId,
    })

    let providerMutationAttempted = false

    try {
      await dependencies.resources.recordBranchResourceCreateIntent(resourceId, context.operationId)
      providerMutationAttempted = true

      await dependencies.driver.writeProvisioningFile(context.namespace, context.rootBranchName, file)
      await dependencies.resources.recordBranchResourceCreateOutcome(resourceId, context.operationId)
    } catch (error: unknown) {
      if (providerMutationAttempted) {
        await recordProvisioningFileFailureBestEffort(
          dependencies.resources,
          context,
          resourceId,
          file.resourceKey,
          error,
          state,
        )
      }

      throw error
    }
  }
}

function createBranchResourceInput(
  context: CreateCapsuleOperationContext,
  resource: {
    resourceType: BranchResourceInput['resourceType']
    resourceKey: string
    cleanupPolicy: BranchResourceInput['cleanupPolicy']
    metadata: Record<string, unknown>
  },
): BranchResourceInput {
  return {
    operationId: context.operationId,
    ownerId: context.ownerId,
    branchId: context.rootBranchId,
    branchName: context.rootBranchName,
    resourceType: resource.resourceType,
    resourceKey: resource.resourceKey,
    cleanupPolicy: resource.cleanupPolicy,
    metadata: resource.metadata,
  }
}

function resolveProvisioningFileBackingResourceId(
  file: CreateCapsuleProvisioningFileResource,
  instanceResourceId: string,
  state: CreateCapsuleExecutionState,
): string {
  if (file.target.target === 'instance') {
    return instanceResourceId
  }

  const backingResourceId = state.compensation.getCreatedVolumeResourceId(file.target.pool, file.target.volumeName)

  if (!backingResourceId) {
    throw new IncusError(
      'Provisioning file targets a managed volume without durable ownership proof.',
      'VALIDATION_ERROR',
      {
        resourceKey: file.resourceKey,
        pool: file.target.pool,
        volumeName: file.target.volumeName,
      },
    )
  }

  return backingResourceId
}

async function recordDirectResourceCreateFailureBestEffort(
  resources: CapsuleBranchResourceStore,
  context: CreateCapsuleOperationContext,
  resourceId: string,
  resourceKey: string,
  phase: CreateCapsuleDirectResourceMutationStep,
  action: string,
  error: unknown,
  state: CreateCapsuleExecutionState,
): Promise<void> {
  try {
    await resources.recordBranchResourceCreateFailure(
      resourceId,
      context.operationId,
      error,
      createCreateCapsuleFailureContext({
        operationId: context.operationId,
        capsuleId: context.capsuleId,
        rootBranchId: context.rootBranchId,
        rootBranchName: context.rootBranchName,
        phase,
        stepKey: phase,
        action,
        resourceId,
        resourceKey,
        providerIntentCommitted: state.providerIntentCommitted,
        providerOwnershipUncertain: true,
      }),
    )
  } catch (persistenceError: unknown) {
    console.error(
      `[CreateCapsuleResourceProvisioning] Failed to persist create failure for resource '${resourceId}'.`,
      persistenceError,
    )
  }
}

async function recordProvisioningFileFailureBestEffort(
  resources: CapsuleBranchResourceStore,
  context: CreateCapsuleOperationContext,
  resourceId: string,
  resourceKey: string,
  error: unknown,
  state: CreateCapsuleExecutionState,
): Promise<void> {
  try {
    await resources.recordBranchResourceCreateFailure(
      resourceId,
      context.operationId,
      error,
      createCreateCapsuleFailureContext({
        operationId: context.operationId,
        capsuleId: context.capsuleId,
        rootBranchId: context.rootBranchId,
        rootBranchName: context.rootBranchName,
        phase: CreateCapsuleStepKey.WRITE_PROVISIONING_FILES,
        stepKey: CreateCapsuleStepKey.WRITE_PROVISIONING_FILES,
        action: 'write_provisioning_file',
        resourceId,
        resourceKey,
        providerIntentCommitted: state.providerIntentCommitted,
      }),
    )
  } catch (persistenceError: unknown) {
    console.error(
      `[CreateCapsuleResourceProvisioning] Failed to persist provisioning-file failure for resource '${resourceId}'.`,
      persistenceError,
    )
  }
}

async function markResourceErrorBestEffort(
  resources: CapsuleBranchResourceStore,
  resourceId: string,
  error: unknown,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    await resources.markBranchResourceError(resourceId, error, context)
  } catch (persistenceError: unknown) {
    console.error(
      `[CreateCapsuleResourceProvisioning] Failed to persist resource error for '${resourceId}'.`,
      persistenceError,
    )
  }
}
