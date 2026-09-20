import { InstallerError } from '../diagnostic/error'
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
    throw new InstallerError({
      code: 'INVALID_IMAGE_SELECTOR',
      facts: [['Observed', 'The selector is empty, too long, contains surrounding whitespace, or contains control characters.']],
      retry: 'qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]',
    })
  }
  if (CASE_INSENSITIVE_FINGERPRINT_PATTERN.test(value) && !FULL_FINGERPRINT_PATTERN.test(value)) {
    throw new InstallerError({
      code: 'IMAGE_FINGERPRINT_NOT_LOWERCASE',
      facts: [['Observed', 'The supplied 64-character fingerprint contains uppercase hexadecimal characters.']],
      retry: 'qiln up --source <checkout> --image <lowercase-fingerprint> [--authorized-keys <roster>]',
    })
  }
  return value
}

export function validateContainerImage(image: IncusImage, fingerprint: string): IncusImage {
  if (!FULL_FINGERPRINT_PATTERN.test(image.fingerprint) || image.fingerprint !== fingerprint) {
    throw new InstallerError({
      code: 'IMAGE_FINGERPRINT_MISMATCH',
      facts: [['Requested image', fingerprint], ['Returned image', image.fingerprint]],
      retry: 'qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]',
    })
  }
  if (image.type !== 'container') {
    throw new InstallerError({
      code: 'IMAGE_TYPE_INCOMPATIBLE',
      facts: [['Image type', image.type], ['Required type', 'container']],
      retry: 'qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]',
    })
  }
  if (image.architecture !== INSTALLER_SPEC.supportedHost.incusArchitecture) {
    throw new InstallerError({
      code: 'IMAGE_ARCHITECTURE_INCOMPATIBLE',
      facts: [['Image architecture', image.architecture], ['Required architecture', INSTALLER_SPEC.supportedHost.incusArchitecture]],
      retry: 'qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]',
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
      throw new InstallerError({
        code: 'IMAGE_ALIAS_NOT_FOUND',
        facts: [['Alias', selector], ['Project', INSTALLER_SPEC.projectName]],
        retry: 'qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]',
      })
    }
    if (!FULL_FINGERPRINT_PATTERN.test(resolvedAlias.target)) {
      throw new InstallerError({
        code: 'IMAGE_ALIAS_TARGET_INVALID',
        facts: [['Alias', selector], ['Alias target', resolvedAlias.target]],
        retry: 'qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]',
      })
    }
    fingerprint = resolvedAlias.target
    resolvedFrom = 'alias'
    selectedAlias = selector
  }
  if (installationState && installationState.imageFingerprint !== fingerprint) {
    throw new InstallerError({
      code: 'IMAGE_PIN_CONFLICT',
      facts: [['Installed image', installationState.imageFingerprint], ['Selected image', fingerprint], ['Selected through', selector]],
      retry: `qiln up --source <checkout> --image ${installationState.imageFingerprint} [--authorized-keys <roster>]`,
    })
  }
  let image: IncusImage
  try {
    image = await client.getImage(fingerprint)
  } catch (error: unknown) {
    if (isIncusApiStatus(error, 404)) {
      throw new InstallerError({
        code: 'IMAGE_NOT_FOUND',
        facts: [['Image', fingerprint]],
        retry: 'qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]',
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
