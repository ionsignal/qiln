import type { InstallationSelector } from './target/types'

/**
 * The one authority for the commands that diagnostics tell an operator to run
 * again. Each entrypoint hands the active workflow's commands down through
 * context, so no lower module names a command.
 */
export interface Retry {
  inspect: string
  configure: string
  configureImage(image: string): string
}

export function selectorFlags(selector: InstallationSelector): string {
  return selector.kind === 'local' ? '--local' : `--${selector.kind} ${selector.value}`
}

/**
 * The commands of the named installation workflow for one selected target.
 */
export function installationRetry(selector: InstallationSelector): Retry {
  const flags = selectorFlags(selector)
  const configure = `qiln installation configure ${flags} --source <checkout>`
  return Object.freeze({
    inspect: `qiln installation inspect ${flags}`,
    configure: `${configure} (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]`,
    configureImage: (image: string) => `${configure} --image ${image} [--authorized-keys <roster>]`,
  })
}
