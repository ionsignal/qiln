import { InstallerError } from './diagnostic/error'
import type { UpCommandOptions } from './commands/up'

export interface UpInput {
  source?: string
  image?: string
  imageMeta?: string
  imageRootfs?: string
  authorizedKeys?: string
  imageFile?: string | boolean
}

function validateValue(value: string | undefined, option: string): void {
  if (value === undefined || (value.trim() !== '' && !value.startsWith('-'))) {
    return
  }
  throw new InstallerError({
    code: 'INVALID_ARGUMENT',
    facts: [['Option', option]],
    retry: 'qiln --help',
  })
}

/**
 * Converts parsed options without accessing installer state or performing any
 * local or provider work.
 */
export function convertUpOptions(input: UpInput): UpCommandOptions {
  if (input.imageFile !== undefined) {
    throw new InstallerError({
      code: 'IMAGE_FILE_INTERFACE_RETIRED',
      facts: [['Observed', '--image-file was supplied.']],
      retry:
        'qiln up --source <checkout> --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs> [--authorized-keys <roster>]',
    })
  }
  validateValue(input.source, '--source')
  validateValue(input.image, '--image')
  validateValue(input.imageMeta, '--image-meta')
  validateValue(input.imageRootfs, '--image-rootfs')
  validateValue(input.authorizedKeys, '--authorized-keys')
  const sourcePath = input.source
  if (sourcePath === undefined) {
    throw new InstallerError({
      code: 'SOURCE_REQUIRED',
      facts: [['Observed', 'No host Qiln checkout was selected.']],
      retry: 'qiln up --source <checkout> --image <alias-or-fingerprint>',
    })
  }
  const hasMetadata = input.imageMeta !== undefined
  const hasRootfs = input.imageRootfs !== undefined
  if (hasMetadata !== hasRootfs) {
    throw new InstallerError({
      code: 'SPLIT_IMAGE_PAIR_REQUIRED',
      facts: [['Observed', hasMetadata ? '--image-rootfs is missing.' : '--image-meta is missing.']],
      retry:
        'qiln up --source <checkout> --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs> [--authorized-keys <roster>]',
    })
  }
  const authorizedKeys =
    input.authorizedKeys === undefined
      ? {}
      : {
          authorizedKeysPath: input.authorizedKeys,
        }
  if (input.image !== undefined && !hasMetadata) {
    return {
      sourcePath,
      image: {
        kind: 'reference',
        value: input.image,
      },
      ...authorizedKeys,
    }
  }
  if (input.image === undefined && input.imageMeta !== undefined && input.imageRootfs !== undefined) {
    return {
      sourcePath,
      image: {
        kind: 'split',
        metadataPath: input.imageMeta,
        rootfsPath: input.imageRootfs,
      },
      ...authorizedKeys,
    }
  }
  const hasReference = input.image !== undefined
  throw new InstallerError({
    code: 'IMAGE_SELECTION_REQUIRED',
    facts: [
      [
        'Observed',
        hasReference
          ? '--image cannot be combined with --image-meta and --image-rootfs.'
          : 'No complete image input was supplied.',
      ],
    ],
    retry: 'qiln --help',
  })
}
