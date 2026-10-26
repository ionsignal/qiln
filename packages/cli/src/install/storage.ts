import { InstallerError } from '../diagnostic/error'
import { INSTALLER_SPEC } from './spec'
import type { IncusStorageVolume, IncusStorageVolumeCreate } from '../incus/types'
import type { Layout } from './layout'

function configDifferences(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): {
  missing: string[]
  unexpected: string[]
} {
  const missing = Object.entries(expected)
    .filter(([key, value]) => actual[key] !== value)
    .map(([key]) => key)
  const unexpected = Object.keys(actual).filter(key => !Object.hasOwn(expected, key) && !key.startsWith('volatile.'))
  return {
    missing,
    unexpected,
  }
}

export function assertVolume(volume: IncusStorageVolume, layout: Layout): void {
  const differences = configDifferences(volume.config, layout.postgres.config)
  const compatible =
    volume.name === layout.postgres.volumeName &&
    volume.type === INSTALLER_SPEC.storage.volumeType &&
    volume.contentType === INSTALLER_SPEC.storage.volumeContentType &&
    volume.description === INSTALLER_SPEC.storage.volumeDescription &&
    (volume.project === '' || volume.project === INSTALLER_SPEC.projectName) &&
    differences.missing.length === 0 &&
    differences.unexpected.length === 0
  if (compatible) {
    return
  }
  throw new InstallerError({
    code: 'INCOMPATIBLE_POSTGRES_VOLUME',
    facts: [
      [
        'Observed',
        `Volume '${volume.name}' reports type='${volume.type}', content_type='${volume.contentType}', description='${volume.description}', and project='${volume.project || INSTALLER_SPEC.projectName}'; missing or mismatched expected keys: ${differences.missing.join(', ') || 'none'}; unexpected non-volatile keys: ${differences.unexpected.join(', ') || 'none'}.`,
      ],
    ],
    retry: 'qiln doctor',
  })
}

export function volumeInput(layout: Layout): IncusStorageVolumeCreate {
  return {
    name: layout.postgres.volumeName,
    type: INSTALLER_SPEC.storage.volumeType,
    contentType: INSTALLER_SPEC.storage.volumeContentType,
    description: INSTALLER_SPEC.storage.volumeDescription,
    config: {
      ...layout.postgres.config,
    },
    source: {},
  }
}
