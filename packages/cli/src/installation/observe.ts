import { INSTALLER_SPEC } from './spec'
import { validateImagePreflight } from './preflight/image'
import { toInstallerError } from '../transport/incus/errors'
import { loadCredentials, type Credentials } from './credentials'
import type { ImageSource } from './image'
import type { IncusClient } from '../transport/incus/client'
import type {
  IncusImage,
  IncusImageAlias,
  IncusInstance,
  IncusNetwork,
  IncusRead,
  IncusStorageVolume,
} from '../transport/incus/types'
import type { Retry } from './retry'
import type { Dir } from '../state/files'
import type { InstallationState } from './state'
import type { InstallationInputs } from './types'

export interface ObservationRequest {
  client: IncusClient
  /** The installation directory that holds the local credential files. */
  directory: Dir
  sshKeygen: string
  source: ImageSource
  installation: InstallationState | null
  inputs: InstallationInputs
  retry: Retry
}

/**
 * One point-in-time read of everything an installation depends on. `image` is
 * the selected content, `alias` is the managed orchestrator alias, and
 * `aliased` is the image that alias currently targets. A reference selection
 * never touches the managed alias. Absent resources are null, and the local
 * credential set is `absent` only when none of its files exist.
 */
export interface Observation {
  kind: ImageSource['kind']
  fingerprint: string
  pin: string | null
  image: IncusImage | null
  alias: IncusImageAlias | null
  aliased: IncusImage | null
  network: IncusNetwork | null
  volume: IncusStorageVolume | null
  instance: IncusRead<IncusInstance> | null
  credentials: Credentials | 'absent'
}

type Images = Pick<Observation, 'fingerprint' | 'image' | 'alias' | 'aliased'>

async function read<T>(retry: string, operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error: unknown) {
    throw toInstallerError(error, { check: 'installation observation', operation, rerun: retry })
  }
}

/**
 * A reference has nothing to import, so it is resolved and validated here and
 * is always present afterwards. Split content may be absent from the store.
 */
async function imagesOf({ client, source, installation, inputs, retry }: ObservationRequest): Promise<Images> {
  if (source.kind === 'reference') {
    const selected = await validateImagePreflight(client, source.selector, installation, inputs.architecture, retry)
    return { fingerprint: selected.fingerprint, image: selected.image, alias: null, aliased: null }
  }
  const imageOf = (fingerprint: string) =>
    read(retry.configure, 'inspect the local content-addressed orchestrator image', () =>
      client.getImageOrNull(fingerprint),
    )
  const alias = await read(retry.configure, 'inspect the managed orchestrator image alias', () =>
    client.getImageAliasOrNull(INSTALLER_SPEC.orchestrator.imageAlias),
  )
  return {
    fingerprint: source.fingerprint,
    image: await imageOf(source.fingerprint),
    alias,
    aliased: alias === null ? null : await imageOf(alias.target),
  }
}

export async function observe(request: ObservationRequest): Promise<Observation> {
  const { client, directory, sshKeygen, source, installation, inputs, retry } = request
  const { layout } = inputs
  return {
    kind: source.kind,
    ...(await imagesOf(request)),
    pin: installation?.imageFingerprint ?? null,
    network: await read(retry.configure, `inspect the '${layout.network.name}' network`, () =>
      client.getNetworkOrNull(layout.network.name),
    ),
    volume: await read(retry.configure, 'inspect the Qiln PostgreSQL custom volume', () =>
      client.getStoragePoolVolumeOrNull(layout.pool.name, INSTALLER_SPEC.storage.volumeType, layout.postgres.volumeName),
    ),
    instance: await read(retry.configure, `inspect the '${INSTALLER_SPEC.orchestrator.name}' instance`, () =>
      client.getInstanceWithEtagOrNull(INSTALLER_SPEC.orchestrator.name),
    ),
    credentials: await loadCredentials(directory, sshKeygen, retry.configure),
  }
}
