import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { QilnInstallerError } from '../error'
import { validateContainerImage, validateImagePreflight } from '../checks/image'
import { toInstallerError } from '../incus/errors'
import { withStage, type StagedFile } from './files'
import { INSTALLER_SPEC } from './spec'
import type { InstallationState } from './state'
import type { LocalIncusClient } from '../incus/client'
import type { IncusImage, IncusImageAlias } from '../incus/types'

const FULL_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/
const RERUN =
  'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]'

export type InstallerImageSelection =
  | {
      kind: 'reference'
      value: string
    }
  | {
      kind: 'split'
      metadataPath: string
      rootfsPath: string
    }

export interface ImageConvergence {
  fingerprint: string
  image: IncusImage
  alias: IncusImageAlias | null
  outcome: 'verified' | 'reused' | 'imported'
  replacement: boolean
}

async function hashFile(hash: ReturnType<typeof createHash>, path: string): Promise<void> {
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
}

async function splitFingerprint(metadata: StagedFile, rootfs: StagedFile): Promise<string> {
  const hash = createHash('sha256')
  await hashFile(hash, metadata.path)
  await hashFile(hash, rootfs.path)
  return hash.digest('hex')
}

async function getAlias(client: LocalIncusClient): Promise<IncusImageAlias | null> {
  try {
    return await client.getImageAliasOrNull(INSTALLER_SPEC.orchestrator.imageAlias)
  } catch (error: unknown) {
    throw toInstallerError(error, {
      check: 'managed orchestrator image alias',
      operation: 'inspect the managed orchestrator image alias',
      rerun: RERUN,
    })
  }
}

async function getImage(client: LocalIncusClient, fingerprint: string): Promise<IncusImage | null> {
  try {
    return await client.getImageOrNull(fingerprint)
  } catch (error: unknown) {
    throw toInstallerError(error, {
      check: 'local orchestrator image',
      operation: 'inspect the local content-addressed orchestrator image',
      rerun: RERUN,
    })
  }
}

async function validateAliasTarget(
  client: LocalIncusClient,
  alias: IncusImageAlias,
): Promise<{ fingerprint: string; image: IncusImage }> {
  if (!FULL_FINGERPRINT_PATTERN.test(alias.target)) {
    throw new QilnInstallerError({
      code: 'MANAGED_IMAGE_ALIAS_TARGET_INVALID',
      check: 'managed orchestrator image alias',
      summary: 'The managed image alias does not target a canonical full fingerprint.',
      observed: `Alias '${alias.name}' targets '${alias.target}'.`,
      reason: 'The destructive replacement path must identify the exact old provider image before deleting it.',
      operatorAction: 'Inspect and repair the managed Incus image alias manually before retrying.',
      rerun: RERUN,
    })
  }
  const image = await getImage(client, alias.target)
  if (!image || image.fingerprint !== alias.target) {
    throw new QilnInstallerError({
      code: 'MANAGED_IMAGE_ALIAS_TARGET_MISSING',
      check: 'managed orchestrator image alias',
      summary: 'The managed image alias target cannot be retrieved exactly.',
      observed: `Alias '${alias.name}' targets '${alias.target}', but that full image could not be validated.`,
      reason: 'Qiln will not delete an unverified or ambiguous image target.',
      operatorAction: 'Inspect the local Incus image and alias state manually before retrying.',
      rerun: RERUN,
    })
  }
  return {
    fingerprint: alias.target,
    image,
  }
}

async function deleteAliasedImage(client: LocalIncusClient, alias: IncusImageAlias): Promise<void> {
  const target = await validateAliasTarget(client, alias)
  try {
    const operation = await client.deleteImage(target.fingerprint)
    await client.waitOperation(operation)
  } catch (error: unknown) {
    throw toInstallerError(error, {
      check: 'explicit development image replacement',
      operation: 'delete the previous image targeted by the managed orchestrator alias',
      rerun: RERUN,
    })
  }
}

async function ensureAlias(client: LocalIncusClient, fingerprint: string): Promise<IncusImageAlias> {
  const existing = await getAlias(client)
  if (existing) {
    if (existing.target !== fingerprint) {
      throw new QilnInstallerError({
        code: 'MANAGED_IMAGE_ALIAS_CONFLICT',
        check: 'managed orchestrator image alias',
        summary: 'The managed image alias points to an unexpected image after replacement cleanup.',
        observed: `Alias target='${existing.target}', required target='${fingerprint}'.`,
        reason: 'Qiln does not retarget an unexpected surviving alias implicitly.',
        operatorAction: 'Inspect the actual Incus image and alias state manually, then rerun qiln up.',
        rerun: RERUN,
      })
    }
    return existing
  }
  try {
    await client.createImageAlias(INSTALLER_SPEC.orchestrator.imageAlias, fingerprint)
  } catch (error: unknown) {
    throw toInstallerError(error, {
      check: 'managed orchestrator image alias',
      operation: 'create the managed orchestrator image alias',
      rerun: RERUN,
    })
  }
  const created = await getAlias(client)
  if (!created || created.name !== INSTALLER_SPEC.orchestrator.imageAlias || created.target !== fingerprint) {
    throw new QilnInstallerError({
      code: 'MANAGED_IMAGE_ALIAS_VERIFICATION_FAILED',
      check: 'managed orchestrator image alias',
      summary: 'The managed image alias could not be verified after creation.',
      observed: `The required alias did not resolve to '${fingerprint}'.`,
      reason: 'Qiln commits installation state only after provider image and alias state are both verified.',
      operatorAction: 'Inspect the local Incus image aliases manually, then rerun qiln up.',
      rerun: RERUN,
    })
  }
  return created
}

async function importImage(
  client: LocalIncusClient,
  fingerprint: string,
  metadata: StagedFile,
  rootfs: StagedFile,
): Promise<void> {
  try {
    const operation = await client.importSplitImage({
      fingerprint,
      alias: INSTALLER_SPEC.orchestrator.imageAlias,
      metadataPath: metadata.path,
      metadataSize: metadata.size,
      rootfsPath: rootfs.path,
      rootfsSize: rootfs.size,
    })
    await client.waitOperation(operation)
  } catch (error: unknown) {
    throw toInstallerError(error, {
      check: 'split orchestrator image import',
      operation: 'upload and import the staged split Incus image',
      rerun: RERUN,
    })
  }
}

async function verifySplitResult(
  client: LocalIncusClient,
  fingerprint: string,
): Promise<{ image: IncusImage; alias: IncusImageAlias }> {
  const image = await getImage(client, fingerprint)
  if (!image) {
    throw new QilnInstallerError({
      code: 'IMPORTED_IMAGE_NOT_FOUND',
      check: 'split orchestrator image verification',
      summary: 'The computed image fingerprint is absent after convergence.',
      observed: `Incus did not return image '${fingerprint}'.`,
      reason: 'The installer cannot commit an image pin that does not resolve to an exact provider image.',
      operatorAction: 'Inspect the local Incus image operations and image store, then rerun qiln up.',
      rerun: RERUN,
    })
  }
  validateContainerImage(image, fingerprint)
  const alias = await getAlias(client)
  if (!alias || alias.name !== INSTALLER_SPEC.orchestrator.imageAlias || alias.target !== fingerprint) {
    throw new QilnInstallerError({
      code: 'MANAGED_IMAGE_ALIAS_VERIFICATION_FAILED',
      check: 'split orchestrator image verification',
      summary: 'The managed image alias does not identify the computed imported image.',
      observed: `Required alias target='${fingerprint}', actual target='${alias?.target ?? 'absent'}'.`,
      reason: 'Both the content-addressed image and managed development alias must converge before state is committed.',
      operatorAction: 'Inspect the local Incus image and alias state manually, then rerun qiln up.',
      rerun: RERUN,
    })
  }
  return {
    image,
    alias,
  }
}

async function convergeSplit(
  client: LocalIncusClient,
  metadataPath: string,
  rootfsPath: string,
): Promise<ImageConvergence> {
  return await withStage(
    [
      {
        sourcePath: metadataPath,
        name: INSTALLER_SPEC.image.metadataStageName,
        minSize: 1,
        maxSize: INSTALLER_SPEC.image.metadataMaximumBytes,
      },
      {
        sourcePath: rootfsPath,
        name: INSTALLER_SPEC.image.rootfsStageName,
        minSize: 1,
        maxSize: INSTALLER_SPEC.image.rootfsMaximumBytes,
      },
    ],
    async files => {
      const metadata = files[0]
      const rootfs = files[1]
      if (!metadata || !rootfs) {
        throw new Error('Split-image staging did not return both required artifacts.')
      }
      const fingerprint = await splitFingerprint(metadata, rootfs)
      const previousAlias = await getAlias(client)
      const replacement = previousAlias !== null
      if (previousAlias) {
        await deleteAliasedImage(client, previousAlias)
      }
      let image = await getImage(client, fingerprint)
      let outcome: ImageConvergence['outcome']
      if (image) {
        validateContainerImage(image, fingerprint)
        await ensureAlias(client, fingerprint)
        outcome = 'reused'
      } else {
        const unexpectedAlias = await getAlias(client)
        if (unexpectedAlias) {
          throw new QilnInstallerError({
            code: 'MANAGED_IMAGE_ALIAS_CONFLICT',
            check: 'managed orchestrator image alias',
            summary: 'The managed image alias unexpectedly survived image replacement cleanup.',
            observed: `Alias target='${unexpectedAlias.target}', pending import fingerprint='${fingerprint}'.`,
            reason: 'Importing with the managed alias would produce ambiguous or conflicting provider state.',
            operatorAction: 'Inspect the local Incus image and alias state manually, then rerun qiln up.',
            rerun: RERUN,
          })
        }
        await importImage(client, fingerprint, metadata, rootfs)
        outcome = 'imported'
      }
      const verified = await verifySplitResult(client, fingerprint)
      image = verified.image
      return {
        fingerprint,
        image,
        alias: verified.alias,
        outcome,
        replacement,
      }
    },
  )
}

export async function convergeImage(
  client: LocalIncusClient,
  selection: InstallerImageSelection,
  installationState: InstallationState | null,
): Promise<ImageConvergence> {
  if (selection.kind === 'reference') {
    const selected = await validateImagePreflight(client, selection.value, installationState)
    return {
      fingerprint: selected.fingerprint,
      image: selected.image,
      alias: null,
      outcome: 'verified',
      replacement: false,
    }
  }
  return await convergeSplit(client, selection.metadataPath, selection.rootfsPath)
}
