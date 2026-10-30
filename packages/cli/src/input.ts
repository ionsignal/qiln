import { installationRetry } from './installation/retry'
import { AWS_SPEC } from './aws/spec'
import { InstallerError } from './diagnostic/error'
import { isOperationId } from './guards'
import { validName, validRegion } from './aws/types'
import type { Retry } from './installation/retry' 
import type { DeploymentSelector } from './aws/deployment/alias'
import type { ConfigureOptions } from './commands/installation/configure'
import type { InstallationSelector } from './installation/target/types'

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

export interface ConfigureInput {
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
 * local or provider work. `retry` names the commands that diagnostics show for
 * the selected target's workflow.
 */
export function convertConfigureOptions(input: ConfigureInput, retry: Retry): ConfigureOptions {
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
      retry: retry.configure,
    })
  }
  const hasMetadata = input.imageMeta !== undefined
  const hasRootfs = input.imageRootfs !== undefined
  if (hasMetadata !== hasRootfs) {
    throw new InstallerError({
      code: 'SPLIT_IMAGE_PAIR_REQUIRED',
      facts: [['Observed', hasMetadata ? '--image-rootfs is missing.' : '--image-meta is missing.']],
      retry: retry.configure,
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

export interface InstallationInput {
  local?: boolean
  id?: string
  alias?: string
}

export interface InstallationConfigureInput extends InstallationInput, ConfigureInput {}

export interface InstallationConfigureOptions {
  selector: InstallationSelector
  options: ConfigureOptions
}

export function convertInstallationSelector(input: InstallationInput): InstallationSelector {
  const supplied = [input.local === true, input.id !== undefined, input.alias !== undefined].filter(Boolean)
  if (supplied.length !== 1) {
    throw new InstallerError({
      code: 'INVALID_ARGUMENT',
      facts: [
        ['Option', '--local, --id, --alias'],
        ['Observed', 'Supply exactly one of --local, --id, or --alias.'],
      ],
      retry: 'qiln installation --help',
    })
  }
  if (input.id !== undefined) {
    return convertAwsDeploymentOptions({ id: input.id }).selector
  }
  if (input.alias !== undefined) {
    return { kind: 'alias', value: validateAwsAlias(input.alias) }
  }
  return { kind: 'local' }
}

export function convertReassignSelector(input: AwsDeploymentInput): DeploymentSelector {
  if ((input.id === undefined) === (input.alias === undefined)) {
    throw new InstallerError({
      code: 'INVALID_ARGUMENT',
      facts: [
        ['Option', '--id, --alias'],
        ['Observed', 'Supply exactly one of --id or --alias.'],
      ],
      retry: 'qiln installation --help',
    })
  }
  return convertAwsDeploymentOptions(input).selector
}

export function convertInstallationConfigureOptions(input: InstallationConfigureInput): InstallationConfigureOptions {
  const selector = convertInstallationSelector(input)
  return {
    selector,
    options: convertConfigureOptions(input, installationRetry(selector)),
  }
}
