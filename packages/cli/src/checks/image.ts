import { QilnInstallerError } from '../error'
import { INSTALLER_SPEC } from '../install/spec'
import { isIncusApiStatus, toInstallerError } from '../incus/errors'
import type { InstallationState } from '../install/state'
import type { LocalIncusClient } from '../incus/client'
import type { IncusImage, IncusImageAlias } from '../incus/types'

const FULL_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/
const CASE_INSENSITIVE_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/i
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
      observed: 'The selector is empty, too long, contains surrounding whitespace, or contains control characters.',
      reason: 'The installer accepts one unambiguous local alias or full lowercase SHA-256 fingerprint.',
      operatorAction:
        'Pass a local Incus alias or a lowercase 64-character hexadecimal image fingerprint with --image.',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]',
    })
  }
  if (CASE_INSENSITIVE_FINGERPRINT_PATTERN.test(value) && !FULL_FINGERPRINT_PATTERN.test(value)) {
    throw new QilnInstallerError({
      code: 'IMAGE_FINGERPRINT_NOT_LOWERCASE',
      check: 'operator-selected image fingerprint',
      summary: 'Full image fingerprints must use lowercase hexadecimal characters.',
      observed: 'The supplied 64-character fingerprint contains uppercase hexadecimal characters.',
      reason: 'Qiln persists one canonical immutable image identity without normalizing operator input silently.',
      operatorAction: 'Pass the same full fingerprint in lowercase.',
      rerun: 'qiln up --source <checkout> --image <lowercase-fingerprint> [--authorized-keys <roster>]',
    })
  }
  return value
}

export function validateContainerImage(image: IncusImage, fingerprint: string): IncusImage {
  if (!FULL_FINGERPRINT_PATTERN.test(image.fingerprint) || image.fingerprint !== fingerprint) {
    throw new QilnInstallerError({
      code: 'IMAGE_FINGERPRINT_MISMATCH',
      check: 'resolved image fingerprint',
      summary: 'Incus returned an image that does not match the selected full fingerprint.',
      observed: `Requested '${fingerprint}', received '${image.fingerprint}'.`,
      reason: 'The installation pin must identify the exact content-addressed provider object.',
      operatorAction: 'Inspect the local Incus image store and image metadata manually.',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]',
    })
  }
  if (image.type !== 'container') {
    throw new QilnInstallerError({
      code: 'IMAGE_TYPE_INCOMPATIBLE',
      check: 'orchestrator image type',
      summary: 'The selected orchestrator image is not a container image.',
      observed: `Incus reports image type '${image.type}'.`,
      reason: 'The development orchestrator is created as an Incus container, not a virtual machine.',
      operatorAction: 'Select or import a trusted local Incus container image.',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]',
    })
  }
  if (image.architecture !== INSTALLER_SPEC.supportedHost.incusArchitecture) {
    throw new QilnInstallerError({
      code: 'IMAGE_ARCHITECTURE_INCOMPATIBLE',
      check: 'orchestrator image architecture',
      summary: 'The selected orchestrator image has an unsupported architecture.',
      observed: `Incus reports architecture '${image.architecture}'; expected '${INSTALLER_SPEC.supportedHost.incusArchitecture}'.`,
      reason:
        'The initial installer requires native x86_64 image metadata and does not accept amd64 or foreign-architecture emulation.',
      operatorAction: 'Select or build a trusted Incus image whose provider metadata reports x86_64.',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]',
    })
  }
  return image
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
    fingerprint = selector
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
        rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]',
      })
    }
    if (!resolvedAlias) {
      throw new QilnInstallerError({
        code: 'IMAGE_ALIAS_NOT_FOUND',
        check: 'operator-selected local Incus image alias',
        summary: `The local image alias '${selector}' does not exist.`,
        observed: `Incus returned not found for the selected alias in project '${INSTALLER_SPEC.projectName}'.`,
        reason: 'The --image path resolves only existing local aliases and never pulls images from a remote server.',
        operatorAction: 'Import the trusted image explicitly or select an existing local alias or full fingerprint.',
        rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]',
      })
    }
    if (!FULL_FINGERPRINT_PATTERN.test(resolvedAlias.target)) {
      throw new QilnInstallerError({
        code: 'IMAGE_ALIAS_TARGET_INVALID',
        check: 'local Incus image alias resolution',
        summary: `The local image alias '${selector}' did not resolve to a canonical full fingerprint.`,
        observed: `Incus returned target '${resolvedAlias.target}'.`,
        reason: 'The orchestrator must be pinned to one immutable lowercase full image fingerprint.',
        operatorAction: 'Repair the local image alias or select the full image fingerprint explicitly.',
        rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]',
      })
    }
    fingerprint = resolvedAlias.target
    resolvedFrom = 'alias'
    selectedAlias = selector
  }
  if (installationState && installationState.imageFingerprint !== fingerprint) {
    throw new QilnInstallerError({
      code: 'IMAGE_PIN_CONFLICT',
      check: 'existing immutable installation image pin',
      summary: 'The selected image conflicts with the existing Qiln installation pin.',
      observed: `Existing pin='${installationState.imageFingerprint}', selected fingerprint='${fingerprint}'.`,
      reason: 'The non-destructive --image path must not replace an existing immutable image selection.',
      operatorAction:
        'Rerun with the existing pinned fingerprint or use the explicit split-image replacement interface after reviewing its destructive consequences.',
      rerun: `qiln up --source <checkout> --image ${installationState.imageFingerprint} [--authorized-keys <roster>]`,
    })
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
        reason: 'Qiln does not pull or automatically replace an image selected through --image.',
        operatorAction:
          'Select an existing trusted local image or import it through the explicit split-image interface.',
        rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]',
        cause: error,
      })
    }
    throw toInstallerError(error, {
      check: 'resolved local Incus image',
      operation: 'retrieve the resolved local image',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]',
    })
  }
  validateContainerImage(image, fingerprint)
  return {
    image,
    fingerprint,
    resolvedFrom,
    selectedAlias,
  }
}
