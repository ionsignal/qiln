import { validateImagePreflight } from '../checks/image'
import { validateSourcePreflight } from '../checks/source'
import { QilnInstallerError } from '../error'
import { readRoster, validateRoster } from '../install/state'
import { doctor } from './doctor'
import type { Reporter } from '../reporter'

export type UpImageSelection =
  | {
      kind: 'reference'
      value: string
    }
  | {
      kind: 'file'
      value: string
    }

export interface UpCommandOptions {
  sourcePath: string
  image: UpImageSelection
  authorizedKeysPath?: string
}

export async function up(options: UpCommandOptions, reporter: Reporter): Promise<void> {
  if (options.image.kind === 'file') {
    throw new QilnInstallerError({
      code: 'FEATURE_DEFERRED',
      check: 'local unified image import',
      summary: 'Local image-file import is reserved but not implemented in Batch 1.',
      observed: `--image-file was supplied for '${options.image.value}'.`,
      reason:
        'Stable tarball staging, transfer hashing, Incus image import, and immutable state persistence belong to Batch 2.',
      operatorAction:
        'For Batch 1 preflight, select an existing local Incus alias or full fingerprint with --image. Do not extract or rewrite the image tarball.',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
  const preflight = await doctor(reporter, {
    summary: false,
  })
  const source = await validateSourcePreflight(options.sourcePath, preflight.host.commandPaths.git)
  const selectedRoster =
    options.authorizedKeysPath === undefined ? preflight.state.roster : await readRoster(options.authorizedKeysPath)
  if (!selectedRoster) {
    throw new QilnInstallerError({
      code: 'AUTHORIZED_KEYS_REQUIRED',
      check: 'orchestrator authorized-key roster',
      summary: 'An orchestrator authorized-key roster is required for the first installation.',
      observed: 'No --authorized-keys path was supplied and no safely read stored roster exists.',
      reason: 'Development SSH access must be derived only from an explicit developer-managed public-key roster.',
      operatorAction:
        'Create a regular file containing at least one normal OpenSSH public key and pass it with --authorized-keys.',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
  const roster = await validateRoster(selectedRoster, preflight.host.commandPaths['ssh-keygen'])
  const image = await validateImagePreflight(preflight.incus.client, options.image.value, preflight.state.installation)
  reporter.row('verified', 'Source', `validated Git checkout '${source.sourceRoot}'`)
  reporter.row('verified', 'Authorized keys', `structurally valid roster · ${roster.size} bytes`)
  reporter.row('verified', 'Image', `${image.fingerprint} · x86_64 container image`)
  reporter.notice(
    'The operator-selected image is trusted guest code. Qiln has not established provenance, authenticity, guest compatibility, or bootstrap readiness.',
  )
  reporter.summary(
    'Batch 1 preflight passed. No credentials, state files, images, networks, profiles, volumes, instances, devices, source files, or services were created or changed.',
  )
}
