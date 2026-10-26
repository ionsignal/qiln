import { InstallerError } from '../diagnostic/error'
import { INSTALLER_SPEC } from '../install/spec'
import { isIncusApiStatus, toInstallerError } from '../incus/errors'
import type { Architecture } from '../install/architecture'
import type { InstallationState } from '../install/state'
import type { IncusClient } from '../incus/client'
import type { IncusImage, IncusImageAlias } from '../incus/types'
import type { Retry } from '../retry'

const FULL_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/
const CASE_INSENSITIVE_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/i
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

export interface ImagePreflight {
  image: IncusImage
  fingerprint: string
  resolvedFrom: 'fingerprint' | 'alias'
  selectedAlias: string | null
}

/**
 * The one canonical image identity: a full lowercase SHA-256.
 */
export function isImageFingerprint(value: string): boolean {
  return FULL_FINGERPRINT_PATTERN.test(value)
}

function validateImageSelector(value: string, retry: Retry): string {
  if (value === '' || value.length > 512 || value.trim() !== value || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new InstallerError({
      code: 'INVALID_IMAGE_SELECTOR',
      facts: [
        [
          'Observed',
          'The selector is empty, too long, contains surrounding whitespace, or contains control characters.',
        ],
      ],
      retry: retry.configure,
    })
  }
  if (CASE_INSENSITIVE_FINGERPRINT_PATTERN.test(value) && !isImageFingerprint(value)) {
    throw new InstallerError({
      code: 'IMAGE_FINGERPRINT_NOT_LOWERCASE',
      facts: [['Observed', 'The supplied 64-character fingerprint contains uppercase hexadecimal characters.']],
      retry: retry.configureImage('<lowercase-fingerprint>'),
    })
  }
  return value
}

export function validateContainerImage(
  image: IncusImage,
  fingerprint: string,
  architecture: Architecture,
  retry: string,
): IncusImage {
  if (!isImageFingerprint(image.fingerprint) || image.fingerprint !== fingerprint) {
    throw new InstallerError({
      code: 'IMAGE_FINGERPRINT_MISMATCH',
      facts: [
        ['Requested image', fingerprint],
        ['Returned image', image.fingerprint],
      ],
      retry,
    })
  }
  if (image.type !== 'container') {
    throw new InstallerError({
      code: 'IMAGE_TYPE_INCOMPATIBLE',
      facts: [
        ['Image type', image.type],
        ['Required type', 'container'],
      ],
      retry,
    })
  }
  if (image.architecture !== architecture.incus) {
    throw new InstallerError({
      code: 'IMAGE_ARCHITECTURE_INCOMPATIBLE',
      facts: [
        ['Image architecture', image.architecture],
        ['Required architecture', architecture.incus],
      ],
      retry,
    })
  }
  return image
}

export async function validateImagePreflight(
  client: IncusClient,
  imageSelector: string,
  installationState: InstallationState | null,
  architecture: Architecture,
  retry: Retry,
): Promise<ImagePreflight> {
  const selector = validateImageSelector(imageSelector, retry)
  let fingerprint: string
  let resolvedFrom: ImagePreflight['resolvedFrom']
  let selectedAlias: string | null
  if (isImageFingerprint(selector)) {
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
        rerun: retry.configure,
      })
    }
    if (!resolvedAlias) {
      throw new InstallerError({
        code: 'IMAGE_ALIAS_NOT_FOUND',
        facts: [
          ['Alias', selector],
          ['Project', INSTALLER_SPEC.projectName],
        ],
        retry: retry.configure,
      })
    }
    if (!isImageFingerprint(resolvedAlias.target)) {
      throw new InstallerError({
        code: 'IMAGE_ALIAS_TARGET_INVALID',
        facts: [
          ['Alias', selector],
          ['Alias target', resolvedAlias.target],
        ],
        retry: retry.configure,
      })
    }
    fingerprint = resolvedAlias.target
    resolvedFrom = 'alias'
    selectedAlias = selector
  }
  if (installationState && installationState.imageFingerprint !== fingerprint) {
    throw new InstallerError({
      code: 'IMAGE_PIN_CONFLICT',
      facts: [
        ['Installed image', installationState.imageFingerprint],
        ['Selected image', fingerprint],
        ['Selected through', selector],
      ],
      retry: retry.configureImage(installationState.imageFingerprint),
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
        retry: retry.configure,
      })
    }
    throw toInstallerError(error, {
      check: 'resolved local Incus image',
      operation: 'retrieve the resolved local image',
      rerun: retry.configure,
    })
  }
  validateContainerImage(image, fingerprint, architecture, retry.configure)
  return {
    image,
    fingerprint,
    resolvedFrom,
    selectedAlias,
  }
}
