import { fromLoginCredentials } from '@aws-sdk/credential-providers'
import { AWS_SPEC } from '../spec'
import { InstallerError } from '../../diagnostic/error'
import { openDir, readChild } from '../../state/files'
import { readProfile } from './profile'
import { requireAwsHost, userId } from '../state'

export const quietLogger = Object.freeze({
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
})

export function configuration(region: string) {
  return {
    region,
    maxAttempts: 1,
    logger: quietLogger,
    requestHandler: {
      connectionTimeout: AWS_SPEC.connectionTimeoutMs,
      requestTimeout: AWS_SPEC.requestTimeoutMs,
    },
  }
}

export function expiresAt(value: { expiration?: Date }): string {
  const expiration = value.expiration
  if (!(expiration instanceof Date) || !Number.isFinite(expiration.getTime()) || expiration.getTime() <= Date.now()) {
    throw new InstallerError({
      code: 'AWS_AUTH_EXPIRED',
    })
  }
  return expiration.toISOString()
}

export async function credentials(region: string) {
  requireAwsHost()
  const home = process.env.HOME
  if (
    !home ||
    process.env.AWS_PROFILE !== AWS_SPEC.profile ||
    process.env.AWS_REGION !== region ||
    process.env.AWS_DEFAULT_REGION !== region ||
    process.env.AWS_CONFIG_FILE !== `${home}/${AWS_SPEC.state.config}` ||
    process.env.AWS_SHARED_CREDENTIALS_FILE !== `${home}/${AWS_SPEC.state.credentials}` ||
    process.env.AWS_LOGIN_CACHE_DIRECTORY !== `${home}/${AWS_SPEC.state.cache}`
  ) {
    throw new InstallerError({
      code: 'AWS_PROFILE_INVALID',
    })
  }
  const directory = await openDir(home, {
    owner: userId(),
    mode: 0o700,
  })
  const config = await readChild(directory, AWS_SPEC.state.config, {
    owner: userId(),
    mode: 0o600,
    minSize: 1,
    maxSize: AWS_SPEC.limits.config,
  })
  readProfile(
    new TextDecoder('utf-8', {
      fatal: true,
    }).decode(config.bytes),
    region,
  )
  const sharedCredentials = await readChild(directory, AWS_SPEC.state.credentials, {
    owner: userId(),
    mode: 0o600,
    maxSize: AWS_SPEC.limits.config,
  })
  if (sharedCredentials.size !== 0) {
    throw new InstallerError({
      code: 'AWS_PROFILE_INVALID',
    })
  }
  const resolved = await fromLoginCredentials({
    profile: AWS_SPEC.profile,
    configFilepath: process.env.AWS_CONFIG_FILE,
    filepath: process.env.AWS_SHARED_CREDENTIALS_FILE,
    ignoreCache: true,
    logger: quietLogger,
    clientConfig: configuration(region),
  })()
  expiresAt(resolved)
  return resolved
}
