import { INSTALLER_SPEC } from './spec'
import { networkInput } from './network'
import { volumeInput } from './storage'
import { delivery, type Observation } from './observe'
import { instancePut, requireNoCollision } from './credentials'
import { assertInstance, instanceInput, isStopped, publishedDevices } from './instance'
import { InstallerError } from '../diagnostic/error'
import type { Retry } from './retry'
import type { ImageSource } from './image'
import type { InstallationInputs } from './types'
import type { ConfigurePlan, IncusAction } from './journal/types'
import type { IncusClient } from '../transport/incus/client'
import type { IncusOperationRef } from '../transport/incus/types'

export interface ApplyContext {
  client: IncusClient
  inputs: InstallationInputs
  source: ImageSource
  retry: Retry
  /**
   * Called once an asynchronous request was accepted and before its wait begins,
   * so the caller can retain the operation reference first.
   */
  accepted: (operation: IncusOperationRef) => Promise<void>
}

/**
 * An action that does not belong to its approved plan is a defect of the
 * caller, never operator-correctable input.
 */
function defect(): never {
  throw new InstallerError({
    code: 'INTERNAL_ERROR',
  })
}

async function wait(context: ApplyContext, operation: IncusOperationRef): Promise<void> {
  await context.accepted(operation)
  await context.client.waitOperation(operation)
}

/**
 * Runs one approved action as exactly one Incus request, with no retry and no
 * reconciliation of a conflict. Incus failures propagate unclassified: whether
 * one was a refusal or an uncertain effect depends on whether the request was
 * accepted, which the caller knows from `accepted`. `observation` supplies the
 * instance and its ETag for the guarded update, the local credential set, and
 * the generated ingress, which must be the one that the plan approved.
 */
export async function apply(
  action: IncusAction,
  plan: ConfigurePlan,
  observation: Observation,
  context: ApplyContext,
): Promise<void> {
  const { client, inputs, source, retry } = context
  const { layout } = inputs
  switch (action) {
    case 'delete-image':
      if (plan.image.replace === null) {
        return defect()
      }
      await wait(context, await client.deleteImage(plan.image.replace.fingerprint))
      return
    case 'import-image':
      if (source.kind !== 'split' || source.fingerprint !== plan.fingerprint) {
        return defect()
      }
      await wait(
        context,
        await client.importSplitImage({
          fingerprint: plan.fingerprint,
          metadataPath: source.metadata.path,
          metadataSize: source.metadata.size,
          rootfsPath: source.rootfs.path,
          rootfsSize: source.rootfs.size,
        }),
      )
      return
    case 'create-alias':
      await client.createImageAlias(INSTALLER_SPEC.orchestrator.imageAlias, plan.fingerprint)
      return
    case 'create-network':
      await client.createNetwork(networkInput(layout))
      return
    case 'create-volume':
      await client.createStoragePoolVolume(layout.pool.name, volumeInput(layout))
      return
    case 'create-instance':
      await wait(context, await client.createInstance(instanceInput(plan.fingerprint, inputs, retry.configure)))
      return
    case 'update-instance': {
      const { instance, credentials, ingress } = observation
      if (instance === null || !isStopped(instance.value)) {
        return defect()
      }
      if (credentials === 'absent') {
        throw new InstallerError({
          code: 'LOCAL_CREDENTIAL_SET_REQUIRED',
          facts: [['Observed', 'The protected installer state directory contains no credential set.']],
          retry: retry.configure,
        })
      }
      const values = delivery(observation)
      if (values === null || ingress?.digest !== plan.ingress) {
        return defect()
      }
      requireNoCollision(instance.value.config, retry.configure)
      assertInstance(instance.value, plan.fingerprint, inputs, retry.configure)
      await wait(
        context,
        await client.updateInstance(
          INSTALLER_SPEC.orchestrator.name,
          instancePut(instance.value, values, publishedDevices(inputs)),
          instance.etag,
        ),
      )
      return
    }
  }
}
