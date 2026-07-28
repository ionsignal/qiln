import { IncusError } from '../../../errors'

const MAX_STORAGE_IDENTITY_LENGTH = 255
const MAX_QUALIFIED_SNAPSHOT_VOLUME_LENGTH = MAX_STORAGE_IDENTITY_LENGTH * 2 + 1
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

export interface IncusCustomVolumeIdentity {
  pool: string
  volume: string
}

export interface IncusStorageSnapshotIdentity {
  pool: string
  sourceVolume: string
  snapshotName: string
  qualifiedVolume: string
}

function assertIdentity(value: string, field: string): void {
  if (
    value.length === 0 ||
    value.trim() !== value ||
    value.length > MAX_STORAGE_IDENTITY_LENGTH ||
    value.includes('/') ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new IncusError(`Incus storage ${field} is invalid.`, 'VALIDATION_ERROR', {
      field,
      value,
      maxLength: MAX_STORAGE_IDENTITY_LENGTH,
    })
  }
}

/**
 * Validates one exact custom-volume provider identity.
 *
 * Pool and volume names are accepted only as concrete Incus endpoint
 * components. Snapshot-qualified volume names must be constructed through
 * `snapshotIdentity()` rather than supplied as arbitrary custom-volume names.
 */
export function volumeIdentity(pool: string, volume: string): IncusCustomVolumeIdentity {
  assertIdentity(pool, 'pool')
  assertIdentity(volume, 'volume')

  return {
    pool,
    volume,
  }
}

/**
 * Validates and constructs one exact custom-volume snapshot identity.
 *
 * The qualified Files API and clone-source identity is derived internally so
 * snapshot creation, reads, cloning, compensation, and committed provider
 * references cannot disagree about how `<source-volume>/<snapshot-name>` is
 * formed.
 */
export function snapshotIdentity(
  pool: string,
  sourceVolume: string,
  snapshotName: string,
): IncusStorageSnapshotIdentity {
  const source = volumeIdentity(pool, sourceVolume)

  assertIdentity(snapshotName, 'snapshot name')

  const qualifiedVolume = `${source.volume}/${snapshotName}`
  if (qualifiedVolume.length > MAX_QUALIFIED_SNAPSHOT_VOLUME_LENGTH) {
    throw new IncusError('Qualified Incus snapshot volume identity is too long.', 'VALIDATION_ERROR', {
      pool: source.pool,
      sourceVolume: source.volume,
      snapshotName,
      length: qualifiedVolume.length,
      maxLength: MAX_QUALIFIED_SNAPSHOT_VOLUME_LENGTH,
    })
  }
  return {
    pool: source.pool,
    sourceVolume: source.volume,
    snapshotName,
    qualifiedVolume,
  }
}

/**
 * Validates a canonical absolute POSIX path used by the custom-volume Files
 * API.
 *
 * Paths are validated independently from provider identities because `/` is
 * structural path syntax here rather than an encoded endpoint component.
 */
export function assertFilePath(value: string): void {
  if (value === '/') {
    return
  }
  if (!value.startsWith('/') || value.endsWith('/') || value.includes('\0')) {
    throw new IncusError('Incus storage file path must be a canonical absolute POSIX path.', 'VALIDATION_ERROR', {
      path: value,
    })
  }
  const segments = value.slice(1).split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new IncusError('Incus storage file path must be a canonical absolute POSIX path.', 'VALIDATION_ERROR', {
      path: value,
    })
  }
}
