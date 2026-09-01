import { QilnInstallerError } from '../error'
import { INSTALLER_SPEC } from '../install/spec'
import { isIncusApiStatus, toInstallerError } from '../incus/errors'
import type { InstallationState } from '../install/state'
import type { LocalIncusClient } from '../incus/client'
import type { IncusImage, IncusImageAlias, IncusInstance } from '../incus/types'

const FULL_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/i
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

export interface ImagePreflight {
  image: IncusImage
  fingerprint: string
  resolvedFrom: 'fingerprint' | 'alias'
  selectedAlias: string | null
}

function validateImageSelector(value: string): string {
  if (value === '' || value.length > 512 || value.trim() !== value || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new QilnInstallerError({
      code: 'INVALID_IMAGE_SELECTOR',
      check: 'operator-selected orchestrator image',
      summary: 'The image selector is malformed.',
      observed: 'The selector is empty, too long, or contains whitespace or control characters.',
      reason: 'The installer accepts one unambiguous local alias or full SHA-256 fingerprint.',
      operatorAction: 'Pass a local Incus alias or a 64-character hexadecimal image fingerprint with --image.',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
  return value
}

export async function validateImagePreflight(
  client: LocalIncusClient,
  imageSelector: string,
  installationState: InstallationState | null,
): Promise<ImagePreflight> {
  const selector = validateImageSelector(imageSelector)
  let fingerprint: string
  let resolvedFrom: ImagePreflight['resolvedFrom']
  let selectedAlias: string | null
  if (FULL_FINGERPRINT_PATTERN.test(selector)) {
    fingerprint = selector.toLowerCase()
    resolvedFrom = 'fingerprint'
    selectedAlias = null
  } else {
    let resolvedAlias: IncusImageAlias | null
    try {
      resolvedAlias = await client.getImageAliasOrNull(selector)
    } catch (error: unknown) {
      throw toInstallerError(error, {
        check: 'operator-selected local Incus image alias',
        operation: 'resolve the selected local image alias',
        rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
      })
    }
    if (!resolvedAlias) {
      throw new QilnInstallerError({
        code: 'IMAGE_ALIAS_NOT_FOUND',
        check: 'operator-selected local Incus image alias',
        summary: `The local image alias '${selector}' does not exist.`,
        observed: `Incus returned not found for /1.0/images/aliases/${selector}.`,
        reason: 'Batch 1 resolves only existing local aliases and never pulls images from a remote server.',
        operatorAction: 'Import the trusted image manually or select an existing local alias or full fingerprint.',
        rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
      })
    }
    if (!FULL_FINGERPRINT_PATTERN.test(resolvedAlias.target)) {
      throw new QilnInstallerError({
        code: 'IMAGE_ALIAS_TARGET_INVALID',
        check: 'local Incus image alias resolution',
        summary: `The local image alias '${selector}' did not resolve to a full fingerprint.`,
        observed: `Incus returned target '${resolvedAlias.target}'.`,
        reason: 'The orchestrator must be created from one immutable full image fingerprint.',
        operatorAction: 'Repair the local image alias or select the full image fingerprint explicitly.',
        rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
      })
    }
    fingerprint = resolvedAlias.target.toLowerCase()
    resolvedFrom = 'alias'
    selectedAlias = selector
  }
  let image: IncusImage
  try {
    image = await client.getImage(fingerprint)
  } catch (error: unknown) {
    if (isIncusApiStatus(error, 404)) {
      throw new QilnInstallerError({
        code: 'IMAGE_NOT_FOUND',
        check: 'resolved local Incus image',
        summary: 'The resolved orchestrator image does not exist in the local Incus image store.',
        observed: `Incus could not retrieve full fingerprint '${fingerprint}'.`,
        reason: 'Qiln does not pull or automatically replace an operator-selected image.',
        operatorAction: 'Select an existing trusted local image or import it manually before retrying.',
        rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
        cause: error,
      })
    }
    throw toInstallerError(error, {
      check: 'resolved local Incus image',
      operation: 'retrieve the resolved local image',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
  if (!FULL_FINGERPRINT_PATTERN.test(image.fingerprint) || image.fingerprint.toLowerCase() !== fingerprint) {
    throw new QilnInstallerError({
      code: 'IMAGE_FINGERPRINT_MISMATCH',
      check: 'resolved image fingerprint',
      summary: 'Incus returned an image that does not match the resolved full fingerprint.',
      observed: `Requested '${fingerprint}', received '${image.fingerprint}'.`,
      reason: 'The immutable installation pin must identify the exact provider object used for instance creation.',
      operatorAction: 'Inspect the local Incus image store and alias definitions manually.',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
  if (image.type !== 'container') {
    throw new QilnInstallerError({
      code: 'IMAGE_TYPE_INCOMPATIBLE',
      check: 'orchestrator image type',
      summary: 'The selected orchestrator image is not a container image.',
      observed: `Incus reports image type '${image.type}'.`,
      reason: 'The development orchestrator is created as an Incus container, not a virtual machine.',
      operatorAction: 'Select a trusted local Incus container image. Qiln will not convert or replace the image.',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
  if (image.architecture !== INSTALLER_SPEC.supportedHost.incusArchitecture) {
    throw new QilnInstallerError({
      code: 'IMAGE_ARCHITECTURE_INCOMPATIBLE',
      check: 'orchestrator image architecture',
      summary: 'The selected orchestrator image has an unsupported architecture.',
      observed: `Incus reports architecture '${image.architecture}'; expected '${INSTALLER_SPEC.supportedHost.incusArchitecture}'.`,
      reason: 'The initial MVP requires a native x86_64 userspace and does not rely on foreign-architecture emulation.',
      operatorAction: 'Select a trusted local x86_64 Incus container image.',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
  if (installationState && installationState.imageFingerprint !== fingerprint) {
    throw new QilnInstallerError({
      code: 'IMAGE_PIN_CONFLICT',
      check: 'existing immutable installation image pin',
      summary: 'The selected image conflicts with the existing Qiln installation pin.',
      observed: `Existing pin='${installationState.imageFingerprint}', selected fingerprint='${fingerprint}'.`,
      reason: 'Deterministic reruns must not silently replace an operator-selected image.',
      operatorAction:
        'Rerun with the existing pinned fingerprint or review a future explicit image migration workflow.',
      rerun: `qiln up --source <checkout> --image ${installationState.imageFingerprint} --authorized-keys <roster>`,
    })
  }
  let installerAlias: IncusImageAlias | null
  try {
    installerAlias = await client.getImageAliasOrNull(INSTALLER_SPEC.orchestrator.imageAlias)
  } catch (error: unknown) {
    throw toInstallerError(error, {
      check: 'installer-owned local Incus image alias',
      operation: 'inspect the installer-owned image alias',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
  if (installerAlias && installerAlias.target.toLowerCase() !== fingerprint) {
    throw new QilnInstallerError({
      code: 'INSTALLER_IMAGE_ALIAS_CONFLICT',
      check: 'installer-owned image alias',
      summary: `The existing '${INSTALLER_SPEC.orchestrator.imageAlias}' image alias points to another image.`,
      observed: `Alias target='${installerAlias.target}', selected fingerprint='${fingerprint}'.`,
      reason: 'Qiln will not retarget an existing conflicting image alias implicitly.',
      operatorAction: 'Inspect the existing alias and installation state manually before proceeding.',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
  let existingInstance: IncusInstance | null
  try {
    existingInstance = await client.getInstanceOrNull(INSTALLER_SPEC.orchestrator.name)
  } catch (error: unknown) {
    throw toInstallerError(error, {
      check: 'existing Qiln orchestrator instance',
      operation: 'inspect the existing orchestrator instance',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
  if (existingInstance) {
    if (existingInstance.type !== 'container') {
      throw new QilnInstallerError({
        code: 'ORCHESTRATOR_INSTANCE_TYPE_CONFLICT',
        check: 'existing orchestrator instance type',
        summary: `The existing '${INSTALLER_SPEC.orchestrator.name}' instance is not a container.`,
        observed: `Incus reports instance type '${existingInstance.type}'.`,
        reason: 'Qiln will not replace or convert an existing conflicting instance.',
        operatorAction:
          'Inspect the existing instance manually and resolve the naming conflict without deleting retained data.',
        rerun: 'qiln doctor',
      })
    }
    const existingBaseImage =
      existingInstance.expandedConfig['volatile.base_image'] ?? existingInstance.config['volatile.base_image']
    if (!existingBaseImage || existingBaseImage.toLowerCase() !== fingerprint) {
      throw new QilnInstallerError({
        code: 'ORCHESTRATOR_IMAGE_CONFLICT',
        check: 'existing orchestrator base image',
        summary: `The existing '${INSTALLER_SPEC.orchestrator.name}' instance does not match the selected image pin.`,
        observed: `Instance base image='${existingBaseImage ?? 'unset'}', selected fingerprint='${fingerprint}'.`,
        reason: 'Qiln will not rebuild or replace an existing orchestrator automatically.',
        operatorAction: 'Select the existing instance image pin or inspect the retained installation manually.',
        rerun: 'qiln up --source <checkout> --image <existing-fingerprint> --authorized-keys <roster>',
      })
    }
  }
  return {
    image,
    fingerprint,
    resolvedFrom,
    selectedAlias,
  }
}
