import type { IndexEntry, Manifest, ManifestEntry, PackageChange, StagedFile } from './types'

/**
 * What a captured closure turned out to be: the manifest to freeze, or the
 * reasons that none can be.
 */
export type Captured = { manifest: Manifest } | { reasons: string[] }

/**
 * The manifest as `sha256:size:filename` words, which is how a script receives
 * it. A filename never contains a colon.
 */
export function manifestWords(manifest: Manifest): string[] {
  return manifest.map(entry => `${entry.sha256}:${entry.size}:${entry.filename}`)
}

/**
 * Pure judgement of one closure against the staged files and the APT index
 * records. A file is identified by the SHA-256 that the repository index lists
 * for its package, version, and architecture, never by its name: APT chooses
 * the name of a downloaded file (it keeps the epoch and may carry an
 * architecture variant), and the index drops both, so neither can be computed
 * from the other. The retained bytes are therefore the bytes the signed
 * metadata vouches for, and the manifest keeps the staged file's own name.
 * Every package is judged, so one run reports everything that blocks.
 */
export function manifestOf(
  closure: readonly PackageChange[],
  stage: readonly StagedFile[],
  index: readonly IndexEntry[],
): Captured {
  const reasons: string[] = []
  const manifest: ManifestEntry[] = []
  for (const change of closure) {
    const label = `${change.name}=${change.version} (${change.architecture})`
    const record = index.find(
      item =>
        item.package === change.name && item.version === change.version && item.architecture === change.architecture,
    )
    const file = record === undefined ? undefined : stage.find(item => item.sha256 === record.sha256 && item.size === record.size)
    if (record === undefined) {
      reasons.push(`The APT index does not list ${label} with a file, a size, and a SHA-256.`)
    } else if (file === undefined) {
      reasons.push(`No file in the staging directory has the size and SHA-256 that the APT index lists for ${label}.`)
    } else {
      manifest.push({
        name: change.name,
        version: change.version,
        architecture: change.architecture,
        filename: file.name,
        size: file.size,
        sha256: file.sha256,
        source: record.filename,
      })
    }
  }
  return reasons.length > 0 ? { reasons } : { manifest }
}
