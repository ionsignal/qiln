import { AWS_SPEC } from './aws/spec'
import { InstallerError } from './diagnostic/error'
import { isOperationId, validName, validRegion } from './aws/types'
import type { DeploymentSelector } from './aws/deployment/alias'
import type { UpCommandOptions } from './commands/up'

export interface AwsInput {
  name?: string
}

export interface AwsCommandOptions {
  name?: string
}

export interface AwsDeploymentCreateInput extends AwsInput {
  alias?: string
}

export interface AwsDeploymentCreateOptions extends AwsCommandOptions {
  alias: string
}

export interface AwsDeploymentInput {
  id?: string
  alias?: string
}

export interface AwsDeploymentOptions {
  selector: DeploymentSelector
}

export type PushSource = 'local' | 'release'

export interface AwsDeploymentPushInput extends AwsDeploymentInput {
  source?: string
}

export interface AwsDeploymentPushOptions extends AwsDeploymentOptions {
  source: PushSource
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

export function validateAwsAlias(alias: string): string {
  if (!validName(alias)) {
    throw new InstallerError({
      code: 'AWS_DEPLOYMENT_ALIAS_INVALID',
      facts: [['Option', '--alias']],
      retry: 'qiln aws deployment --help',
    })
  }
  return alias
}

export function convertAwsDeploymentCreateOptions(input: AwsDeploymentCreateInput): AwsDeploymentCreateOptions {
  return {
    ...convertAwsOptions(input),
    alias: validateAwsAlias(input.alias ?? AWS_SPEC.deployment.defaultName),
  }
}

/** The ID and the alias are alternatives; with neither, the default alias is selected. */
export function convertAwsDeploymentOptions(input: AwsDeploymentInput): AwsDeploymentOptions {
  if (input.id !== undefined && input.alias !== undefined) {
    throw new InstallerError({
      code: 'INVALID_ARGUMENT',
      facts: [
        ['Option', '--id, --alias'],
        ['Observed', 'Supply either --id or --alias, not both.'],
      ],
      retry: 'qiln aws deployment --help',
    })
  }
  if (input.id !== undefined) {
    if (!isOperationId(input.id)) {
      throw new InstallerError({
        code: 'INVALID_ARGUMENT',
        facts: [['Option', '--id']],
        retry: 'qiln aws deployment --help',
      })
    }
    return {
      selector: { kind: 'id', value: input.id },
    }
  }
  return {
    selector: { kind: 'alias', value: validateAwsAlias(input.alias ?? AWS_SPEC.deployment.defaultName) },
  }
}

/**
 * `release` is recognized so that the push command itself can refuse it. The
 * source is a plain string rather than a Commander choice, because a Commander
 * argument error is always reported as an invalid color mode.
 */
export function convertAwsDeploymentPushOptions(input: AwsDeploymentPushInput): AwsDeploymentPushOptions {
  const { source = 'local', ...selection } = input
  if (source !== 'local' && source !== 'release') {
    throw new InstallerError({
      code: 'INVALID_ARGUMENT',
      facts: [
        ['Option', '--source'],
        ['Observed', 'The source must be local or release.'],
      ],
      retry: 'qiln aws deployment --help',
    })
  }
  return {
    ...convertAwsDeploymentOptions(selection),
    source,
  }
}

export function resolveAwsName(options: AwsCommandOptions): string {
  return convertAwsOptions(options).name ?? AWS_SPEC.defaultName
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
