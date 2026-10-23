import { RECIPE } from '../../../../remote/zfs/recipe'
import { ZFS_SPEC } from '../../../../remote/zfs/spec'
import { diskOf } from '../../../../remote/zfs/disk'
import type { DiagnosticFact } from '../../../../diagnostic/error'
import type { ApprovedPlan, Observation, Plan, ZfsTarget } from '../../../../remote/zfs/types'
import type { Reporter } from '../../../../terminal/reporter'

const GIB = 1_073_741_824
const BOOT_IMPORT =
  'Qiln configures none and makes no claim about whether packaged ZFS units import the pool after a reboot'

export interface PlanPreview {
  observation: Observation
  plan: Plan
  target: ZfsTarget
}

function gib(bytes: number): string {
  return `${(bytes / GIB).toFixed(3)} GiB`
}

/**
 * The wording of the default-no approval that goes with each displayed plan.
 */
export function approvalLabel(plan: ApprovedPlan): string {
  switch (plan.kind) {
    case 'prerequisites':
      return 'Apply the displayed prerequisite plan to the deployment host'
    case 'create':
      return 'Create the displayed ZFS pool on the recorded data volume and enable its scrub timer'
    case 'import':
      return 'Import the displayed ZFS pool and enable its scrub timer'
    case 'export':
      return 'Export the displayed ZFS pool from the deployment host'
  }
}

function hostFacts({ observation, target }: PlanPreview): DiagnosticFact[] {
  const { system, module: zfsModule, packages, arc, disks, pools } = observation
  const root = diskOf(disks, target.rootVolumeId)
  const data = diskOf(disks, target.dataVolumeId)
  const others = disks.filter(disk => disk.type === 'disk' && disk !== root && disk !== data)
  const userspace = ZFS_SPEC.packages
    .map(name => {
      const found = packages.find(item => item.name === name && item.installed)
      return found === undefined ? `${name} not installed` : `${name} ${found.version}`
    })
    .join(', ')
  return [
    ['Instance', target.instanceId],
    ['Kernel', `${system.kernel} · ${system.architecture}`],
    ['Memory', `${gib(system.memoryBytes)} total`],
    ['Reboot flag', system.rebootRequired ? 'a reboot is required' : 'none'],
    [
      'ZFS module',
      zfsModule === null
        ? 'not found for the running kernel'
        : `${zfsModule.version} · ${zfsModule.package ?? 'no owning package'} · ${zfsModule.loaded ? 'loaded' : 'not loaded'}`,
    ],
    ['ZFS userspace', userspace],
    ['ARC limit', arc.runningMax === null ? 'module not loaded' : `${arc.runningMax} bytes (0 means the module default)`],
    ['Imported pools', pools.imported.map(pool => `${pool.name} (GUID ${pool.guid})`).join(', ') || 'none'],
    [
      'Root volume',
      root === null
        ? `${target.rootVolumeId} · not found as a single disk`
        : `${root.path} · ${target.rootVolumeId} · ${gib(root.sizeBytes)}`,
    ],
    [
      'Data volume',
      data === null
        ? `${target.dataVolumeId} · not found as a single disk`
        : `${data.path} · ${target.dataVolumeId} · ${gib(data.sizeBytes)} · logical ${data.logicalSector ?? 'unknown'} / physical ${data.physicalSector ?? 'unknown'} byte sectors`,
    ],
    ...others.map(
      (disk): DiagnosticFact => [
        'Other disk',
        `${disk.path} · ${disk.model ?? 'unknown model'} · ${gib(disk.sizeBytes)} · never selected`,
      ],
    ),
  ]
}

function reportPrerequisites(reporter: Reporter, plan: Extract<Plan, { kind: 'prerequisites' }>): void {
  const { arc } = plan
  reporter.section('Proposed prerequisites (applied only after approval)')
  reporter.facts([
    [
      'Packages',
      plan.install.length === 0
        ? 'already installed'
        : plan.install.map(change => `${change.name} ${change.version} (${change.architecture})`).join(', '),
    ],
    ['Kernel module', plan.loadModule ? 'would be loaded' : 'already loaded'],
    ['ARC limit', `${arc.maxBytes} bytes (${gib(arc.maxBytes)}) · ${arc.percent}% of ${gib(arc.memoryBytes)} total memory`],
    ['ARC file', `${ZFS_SPEC.arc.file} · ${arc.writeFile ? 'would be written' : 'already matches'}`],
    ['ARC runtime', arc.applyRuntime ? 'the running limit would be set' : 'no runtime change'],
    ...(plan.expectedPool === null
      ? []
      : [
          [
            'Recorded pool',
            `GUID ${plan.expectedPool} · installing packages may import it, so its state is recorded as unknown until a later step observes it`,
          ] as DiagnosticFact,
        ]),
  ])
}

function reportCreate(reporter: Reporter, plan: Extract<Plan, { kind: 'create' }>): void {
  const { pool, defaults } = ZFS_SPEC
  reporter.section('Proposed storage (applied only after approval)')
  reporter.facts([
    ['Pool', plan.pool],
    ['Target', `${plan.disk.path} · ${plan.disk.volumeId} · ${gib(plan.disk.sizeBytes)} · whole disk`],
    ['Layout', 'one disk vdev; no redundancy, log, cache, spare, or special vdev'],
    ['Pool properties', `ashift=${plan.ashift} autotrim=${plan.autotrim} cachefile=${pool.cachefile}`],
    [
      'Root dataset',
      `mountpoint=${pool.mountpoint} compression=${defaults.compression} acltype=${pool.acltype} xattr=${pool.xattr} atime=${defaults.atime}`,
    ],
    ['Scrub', `${plan.scrubTimer} · packaged monthly timer, enabled and started once the pool is verified`],
    ['Boot import', BOOT_IMPORT],
  ])
}

function reportImport(reporter: Reporter, plan: Extract<Plan, { kind: 'import' }>): void {
  reporter.section('Proposed storage (applied only after approval)')
  reporter.facts([
    ['Pool', `${plan.pool} · GUID ${plan.guid} · recorded for this volume by earlier preparation evidence`],
    ['Target', `${plan.disk.path} · ${plan.disk.volumeId} · ${gib(plan.disk.sizeBytes)} · whole disk`],
    ['Member', `${plan.disk.member} · the only ZFS member partition of the target disk; pool labels are read here`],
    [
      'Import',
      plan.imported
        ? 'already imported; a fenced, idempotent step records and verifies it'
        : 'imported by GUID and original name, without mounting, forcing, renaming, or a cache file',
    ],
    ['Scrub', `${plan.scrubTimer} · packaged monthly timer, enabled and started once the pool is verified`],
    ['Boot import', BOOT_IMPORT],
  ])
}

function reportExport(reporter: Reporter, plan: Extract<Plan, { kind: 'export' }>): void {
  reporter.section('Proposed export (applied only after approval)')
  reporter.facts([
    ['Pool', `${plan.pool} · GUID ${plan.guid}`],
    ['Target', `${plan.disk.path} · ${plan.disk.volumeId} · ${gib(plan.disk.sizeBytes)} · whole disk`],
    [
      'Export',
      'refused before any change if a dataset is mounted or a scrub or resilver is in progress; otherwise the scrub timer is disabled and the pool is exported without force',
    ],
    ['Scrub', `${plan.scrubTimer} · disabled before the export`],
  ])
}

const PREREQUISITE_NOTICE =
  'Approval authorizes only the listed steps, each one fenced remote script followed by a fresh inspection that must agree. ' +
  'The package step, when listed, is always followed by a fresh plan and a new approval for anything that remains. ' +
  'Installing packages can load the ZFS module and start ZFS services as part of the package’s own configuration, which Qiln ' +
  'does not control. No pool is created, imported, or exported by this plan, and a later storage plan needs its own approval. ' +
  'A failed or cancelled step is not replayed, resumed, or rolled back, and interrupted work may already have completed.'

const STORAGE_NOTICE =
  'Approval authorizes only the listed steps, each one fenced remote script followed by a fresh inspection that must agree. ' +
  'Nothing is forced, wiped, repaired, or renamed. A failed or cancelled step is not replayed, resumed, or rolled back, and ' +
  'interrupted work may already have completed. A single-disk pool provides no redundancy or backup.'

/**
 * Renders what was observed and what a later approved step would do. Every
 * proposed section describes a plan only: nothing in it has been applied until
 * the approval that follows it.
 */
export function reportPlan(reporter: Reporter, preview: PlanPreview): void {
  const { plan } = preview
  reporter.section('Observed on the host (read-only)')
  reporter.facts(hostFacts(preview))
  switch (plan.kind) {
    case 'refused':
    case 'reboot':
      return
    case 'ready':
      reporter.section('Storage')
      reporter.facts([
        [
          'Pool',
          `${plan.pool} · GUID ${plan.guid} · observed imported and online as a single plain disk on the recorded data volume, with its monthly scrub timer enabled`,
        ],
      ])
      return
    case 'absent':
      reporter.section('Storage')
      reporter.facts([
        [
          'Pool',
          `${plan.pool} · GUID ${plan.guid} · observed not imported on the host just now, which agrees with the retained evidence of its verified clean export. This is point-in-time, and nothing was changed or recorded.`,
        ],
      ])
      return
    case 'prerequisites':
      reportPrerequisites(reporter, plan)
      break
    case 'create':
      reportCreate(reporter, plan)
      break
    case 'import':
      reportImport(reporter, plan)
      break
    case 'export':
      reportExport(reporter, plan)
      break
  }
  reporter.space()
  reporter.info(`Recipe revision ${RECIPE.revision} · SHA-256 ${RECIPE.digest}`)
  reporter.space()
  reporter.notice(plan.kind === 'prerequisites' ? PREREQUISITE_NOTICE : STORAGE_NOTICE)
}
