import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { InstallerError } from '../../diagnostic/error'
import { inspectChild, openChildDir, writeChild, type Dir } from '../../state/files'
import { isErrorCode } from '../errors'
import { AWS_SPEC } from '../spec'
import { userId } from '../state'
import { isReply, validRegion, type AwsAuthentication, type AwsRequest } from '../types'
import { request } from './child'

async function inspectAuth(directory: Dir): Promise<void> {
  for (const name of await directory.list()) {
    if (![AWS_SPEC.state.config, AWS_SPEC.state.credentials, AWS_SPEC.state.cache].includes(name)) {
      throw new InstallerError({
        code: 'AWS_PROFILE_INVALID',
      })
    }
    const kind = await inspectChild(directory, name, {
      owner: userId(),
      fileMode: 0o600,
      directoryMode: 0o700,
      maxFileSize: AWS_SPEC.limits.config,
    })
    if (name === AWS_SPEC.state.cache) {
      if (kind !== 'directory') {
        throw new InstallerError({
          code: 'AWS_PROFILE_INVALID',
        })
      }
      const cache = await openChildDir(directory, name, {
        owner: userId(),
        mode: 0o700,
      })
      for (const tokenFile of await cache.list()) {
        if (!/^[a-f0-9]{64}\.json$/.test(tokenFile)) {
          throw new InstallerError({
            code: 'AWS_PROFILE_INVALID',
          })
        }
        const tokenKind = await inspectChild(cache, tokenFile, {
          owner: userId(),
          fileMode: 0o600,
          maxFileSize: AWS_SPEC.limits.cache,
        })
        if (tokenKind !== 'file') {
          throw new InstallerError({
            code: 'AWS_PROFILE_INVALID',
          })
        }
      }
    } else if (kind !== 'file') {
      throw new InstallerError({
        code: 'AWS_PROFILE_INVALID',
      })
    }
  }
}

export class Session {
  private constructor(
    private readonly directory: Dir,
    public readonly region: string,
  ) {}

  public static async create(parent: Dir, region: string): Promise<Session> {
    if (!validRegion(region)) {
      throw new InstallerError({
        code: 'AWS_REGION_INVALID',
      })
    }
    const directory = await openChildDir(
      parent,
      AWS_SPEC.state.auth,
      {
        owner: userId(),
        mode: 0o700,
      },
      true,
    )
    if ((await directory.list()).length !== 0) {
      throw new InstallerError({
        code: 'AWS_PROFILE_INVALID',
      })
    }
    await openChildDir(
      directory,
      AWS_SPEC.state.cache,
      {
        owner: userId(),
        mode: 0o700,
      },
      true,
    )
    await writeChild(
      directory,
      AWS_SPEC.state.config,
      Buffer.from(`[profile ${AWS_SPEC.profile}]\nregion = ${region}\noutput = json\n`),
      0o600,
    )
    await writeChild(directory, AWS_SPEC.state.credentials, new Uint8Array(), 0o600)
    return new Session(directory, region)
  }

  public static async open(parent: Dir, region: string): Promise<Session> {
    let directory: Dir
    try {
      directory = await openChildDir(parent, AWS_SPEC.state.auth, {
        owner: userId(),
        mode: 0o700,
      })
    } catch (error: unknown) {
      if (isErrorCode(error, 'ENOENT')) {
        throw new InstallerError({
          code: 'AWS_AUTH_FAILED',
          retry: 'qiln aws connect',
        })
      }
      throw error
    }
    await inspectAuth(directory)
    const names = await directory.list()
    if (
      !names.includes(AWS_SPEC.state.config) ||
      !names.includes(AWS_SPEC.state.credentials) ||
      !names.includes(AWS_SPEC.state.cache)
    ) {
      throw new InstallerError({
        code: 'AWS_PROFILE_INVALID',
      })
    }
    return new Session(directory, region)
  }

  public environment(interactive = false): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      HOME: this.directory.path,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      AWS_CONFIG_FILE: join(this.directory.path, AWS_SPEC.state.config),
      AWS_SHARED_CREDENTIALS_FILE: join(this.directory.path, AWS_SPEC.state.credentials),
      AWS_LOGIN_CACHE_DIRECTORY: join(this.directory.path, AWS_SPEC.state.cache),
      AWS_PROFILE: AWS_SPEC.profile,
      AWS_REGION: this.region,
      AWS_DEFAULT_REGION: this.region,
      AWS_EC2_METADATA_DISABLED: 'true',
      AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
      AWS_CLI_AGENT_TOOLKIT_HINT_DISABLED: 'true',
      AWS_CLI_AUTO_PROMPT: 'off',
      AWS_PAGER: '',
    }
    if (interactive) {
      // Browser integration needs the operator's desktop context, not AWS
      // credentials, endpoint overrides, proxy settings, or Node options.
      for (const key of [
        'HOME',
        'TERM',
        'DISPLAY',
        'WAYLAND_DISPLAY',
        'XDG_RUNTIME_DIR',
        'DBUS_SESSION_BUS_ADDRESS',
        'XAUTHORITY',
        'BROWSER',
      ]) {
        const value = process.env[key]
        if (value !== undefined) {
          environment[key] = value
        }
      }
    }
    return environment
  }

  public async verify(signal: AbortSignal): Promise<AwsAuthentication> {
    await inspectAuth(this.directory)
    const input: AwsRequest = {
      kind: 'identity',
      region: this.region,
    }
    const reply = await request(AWS_SPEC.processFile, this.environment(), input, isReply, signal)
    await inspectAuth(this.directory)
    if (!reply.ok) {
      throw new InstallerError({
        code: reply.code,
        retry: 'qiln aws connect',
      })
    }
    if (new Date(reply.authentication.expiresAt).getTime() <= Date.now()) {
      throw new InstallerError({
        code: 'AWS_AUTH_EXPIRED',
        retry: 'qiln aws connect',
      })
    }
    return reply.authentication
  }
}

export async function removeAuth(parent: Dir): Promise<void> {
  let directory: Dir
  try {
    directory = await openChildDir(parent, AWS_SPEC.state.auth, {
      owner: userId(),
      mode: 0o700,
    })
  } catch (error: unknown) {
    if (isErrorCode(error, 'ENOENT')) {
      return
    }
    throw new InstallerError({
      code: 'AWS_CLEANUP_FAILED',
      facts: [['Observed', 'Authentication state could not be opened safely for local removal.']],
    })
  }
  try {
    await inspectAuth(directory)
  } catch {
    throw new InstallerError({
      code: 'AWS_CLEANUP_FAILED',
      facts: [['Observed', 'Authentication state could not be validated for local removal.']],
    })
  }
  try {
    await rm(parent.child(AWS_SPEC.state.auth), {
      recursive: true,
    })
    await parent.sync()
    if ((await parent.list()).includes(AWS_SPEC.state.auth)) {
      throw new Error('Authentication directory remains present.')
    }
  } catch {
    throw new InstallerError({
      code: 'AWS_CLEANUP_FAILED',
      facts: [['Observed', 'Authentication state removal or directory synchronization did not complete.']],
    })
  }
}
