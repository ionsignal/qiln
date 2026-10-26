import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { INSTALLER_SPEC } from './spec'
import { withStage, type StagedFile } from '../state/files'

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

/**
 * What an installation observes and plans against. A reference is resolved
 * during observation. Split artifacts stay staged for as long as the source is
 * in use, and their fingerprint is computed from the staged bytes.
 */
export type ImageSource =
  | {
      kind: 'reference'
      selector: string
    }
  | {
      kind: 'split'
      fingerprint: string
      metadata: StagedFile
      rootfs: StagedFile
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

/**
 * Copies the split artifacts into a private stage that exists only while `run`
 * is pending.
 */
async function withSplitFiles<T>(
  metadataPath: string,
  rootfsPath: string,
  run: (metadata: StagedFile, rootfs: StagedFile) => Promise<T>,
): Promise<T> {
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
      return await run(metadata, rootfs)
    },
  )
}

/**
 * Keeps split artifacts staged, and their fingerprint known, for as long as an
 * installation plans, applies, and verifies against them.
 */
export async function withImageSource<T>(
  selection: InstallerImageSelection,
  run: (source: ImageSource) => Promise<T>,
): Promise<T> {
  if (selection.kind === 'reference') {
    return await run({ kind: 'reference', selector: selection.value })
  }
  return await withSplitFiles(
    selection.metadataPath,
    selection.rootfsPath,
    async (metadata, rootfs) =>
      await run({ kind: 'split', fingerprint: await splitFingerprint(metadata, rootfs), metadata, rootfs }),
  )
}
