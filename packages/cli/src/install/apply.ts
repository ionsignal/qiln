import { InstallerError } from '../diagnostic/error'
import { instancePut } from './credentials'
import { instanceInput } from './instance'
import { networkInput } from './network'
import { volumeInput } from './storage'
import { INSTALLER_SPEC } from './spec'
import type { IncusClient } from '../incus/client'
import type { IncusOperationRef } from '../incus/types'
import type { ImageSource } from './image'
import type { ConfigurePlan, InstallAction } from './journal/types'
import type { Observation } from './observe'
import type { InstallationInputs } from './types'

const RERUN =
  'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]'

export interface ApplyContext {
  client: IncusClient
  inputs: InstallationInputs
  source: ImageSource
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
 * instance and its ETag for the guarded update, and the local credential set.
 */
export async function apply(
  action: InstallAction,
  plan: ConfigurePlan,
  observation: Observation,
  context: ApplyContext,
): Promise<void> {
  const { client, inputs, source } = context
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
          alias: INSTALLER_SPEC.orchestrator.imageAlias,
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
      await wait(context, await client.createInstance(instanceInput(plan.fingerprint, inputs)))
      return
    case 'update-instance': {
      const { instance, credentials } = observation
      if (instance === null) {
        return defect()
      }
      if (credentials === 'absent') {
        throw new InstallerError({
          code: 'LOCAL_CREDENTIAL_SET_REQUIRED',
          facts: [['Observed', 'The protected installer state directory contains no credential set.']],
          retry: RERUN,
        })
      }
      await wait(
        context,
        await client.updateInstance(
          INSTALLER_SPEC.orchestrator.name,
          instancePut(instance.value, credentials.values),
          instance.etag,
        ),
      )
      return
    }
  }
}
