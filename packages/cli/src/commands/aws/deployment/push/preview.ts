import { deploymentName } from '../../../../aws/deployment/alias'
import { MIB, SOURCE_SPEC } from '../../../../source/spec'
import type { DiagnosticFact } from '../../../../diagnostic/error'
import type { Destination } from '../../../../remote/deliver'
import type { Archive } from '../../../../source/archive'
import type { Selection } from '../../../../source/select'
import type { Reporter } from '../../../../terminal/reporter'
import type { Access } from '../access'

export interface PushPreview {
  access: Access
  selection: Selection
  archive: Archive
  destination: Destination
}

export function mib(bytes: number): string {
  return (bytes / MIB).toFixed(1)
}

function exclusionFacts(selection: Selection): DiagnosticFact[] {
  const { excluded, trackedExcluded } = selection
  const facts: DiagnosticFact[] = excluded.map(({ reason, count }): DiagnosticFact => [
    'Left out',
    `${count} ${count === 1 ? 'path' : 'paths'} · ${reason}`,
  ])
  if (facts.length === 0) {
    facts.push(['Left out', 'nothing matched the exclusion policy'])
  }
  if (trackedExcluded.total > 0) {
    const more = trackedExcluded.total > trackedExcluded.names.length ? ', ...' : ''
    facts.push([
      'Tracked, left out',
      `${trackedExcluded.total} · ${trackedExcluded.names.slice(0, SOURCE_SPEC.listedExclusions).join(', ')}${more}`,
    ])
  }
  return facts
}

/**
 * Everything shown here comes from the scan, the captured archive, the retained
 * pin, and the generated destination, so the approval describes exactly what
 * the delivery will use.
 */
export function reportPush(reporter: Reporter, { access, selection, archive, destination }: PushPreview): void {
  const { record, options } = access
  reporter.section('Source package')
  reporter.facts([
    ['Source root', selection.root],
    ['Selected', `${selection.files.length} files · ${mib(selection.unpackedBytes)} MiB unpacked`],
    ['Archive', `${mib(archive.bytes)} MiB compressed · ${archive.bytes} bytes`],
    ['SHA-256', archive.sha256],
    ...exclusionFacts(selection),
  ])
  reporter.section('Delivery')
  reporter.facts([
    ['Deployment', `${deploymentName(record.alias)} · ${record.id}`],
    ['Endpoint', `${options.username}@${options.host}:${options.port}`],
    ['Pinned host key', `SHA256:${options.fingerprint} · AWS console evidence; not guest attestation`],
    ['Attempt', destination.id],
    ['Archive path', destination.archive],
    ['Source path', destination.source],
  ])
  reporter.space()
  reporter.info('Nothing has been uploaded or changed on the guest yet.')
  reporter.notice(
    'The selection is the working tree as scanned now, including uncommitted changes. Git ignore rules and filename filtering are not a secret filter and do not prove that the source contains no secrets. Git-ignored files and lockfiles are not selected.',
  )
  reporter.notice(
    'The package is a private local archive that was checked for changes before and after packaging. It is not an atomic snapshot, a published release, or a reproducible build. It contains no .git directory, so the extracted source is not a Git checkout.',
  )
  reporter.notice(
    'Approval connects with the pinned host key, requires the guest baseline to pass, then creates a new attempt directory, uploads the archive exclusively, compares its SHA-256 on the guest, and extracts it into source/ without sudo. Nothing is installed, built, started, activated, replaced, or deleted.',
  )
  reporter.notice(
    'A failure or cancellation does not roll back or delete anything on the guest, and nothing is retried or resumed. Remote artifacts stay as evidence, and a new attempt uses a new directory.',
  )
}
