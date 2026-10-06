import { InstallerError } from './diagnostic/error'
import { validName, validRegion } from './aws/types'
import type { UpCommandOptions } from './commands/up'

export interface AwsInput {
  name?: string
}

export interface AwsCommandOptions {
  name?: string
}

export function convertAwsOptions(input: AwsInput): AwsCommandOptions {
  if (input.name === undefined) {
    return {}
  }
  if (!validName(input.name)) {
    throw new InstallerError({
      code: 'AWS_CONNECTION_NAME_INVALID',
      facts: [['Option', '--name']],
      retry: 'qiln aws --help',
    })
  }
  return {
    name: input.name,
  }
}

export function requireAwsName(options: AwsCommandOptions): string {
  const name = convertAwsOptions(options).name
  if (name === undefined) {
    throw new InstallerError({
      code: 'AWS_CONNECTION_NAME_REQUIRED',
      retry: 'qiln aws --help',
    })
  }
  return name
}

export function validateAwsRegion(region: string): string {
  if (!validRegion(region)) {
    throw new InstallerError({
      code: 'AWS_REGION_INVALID',
      retry: 'qiln aws connect',
    })
  }
  return region
}

export interface UpInput {
  source?: string
  image?: string
  imageMeta?: string
  imageRootfs?: string
  authorizedKeys?: string
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
