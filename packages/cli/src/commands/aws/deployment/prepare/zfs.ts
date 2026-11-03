import { ZFS_SPEC, datasetNamesOf, type StepAction } from '../../../../host/zfs/spec'
import { diskOf } from '../../../../host/zfs/disk'
import { STATE_MOUNTPOINT } from '../../../../host/mount'
import { actionsOf } from '../../../../aws/deployment/zfs/types'
import { ZFS_LABELS, reportApproval, stepsOf, type ApprovalScreen } from './steps'
import type { DiagnosticFact } from '../../../../diagnostic/error'
import type {
  ApprovedPlan,
  CreatePlan,
  ExportPlan,
  ImportPlan,
  Observation,
  Plan,
  PrerequisitePlan,
  ZfsTarget,
} from '../../../../host/zfs/types'
import type { Reporter } from '../../../../terminal/reporter'

const GIB = 1_073_741_824
const NO_BOOT_IMPORT = 'Whether packaged ZFS units import the pool after a reboot; Qiln configures none.'
const NO_REDUNDANCY = 'A single-disk pool has no redundancy or backup.'
const AFTER_REBOOT = 'The state dataset stays unmounted after a reboot until a later prepare mounts it.'
const ACTIVATION = 'Incus activation, which needs its own approvals.'

type Details = Partial<Record<StepAction, string>>

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
      return `Create the displayed ZFS pool and its datasets on the recorded data volume, enable its scrub timer, and mount its state dataset at ${STATE_MOUNTPOINT}`
    case 'import':
      return plan.mountOnly
        ? `Mount the displayed state dataset at ${STATE_MOUNTPOINT} on the deployment host`
        : `Import the displayed ZFS pool, enable its scrub timer, and mount its state dataset at ${STATE_MOUNTPOINT}`
    case 'export':
      return plan.unmount
        ? 'Unmount the displayed state dataset and export the displayed ZFS pool from the deployment host'
        : 'Export the displayed ZFS pool from the deployment host'
  }
}

/**
 * The full inventory, shown only when a plan is refused, because that evidence
 * explains the refusal.
 */
function hostFacts({ observation, target }: PlanPreview): DiagnosticFact[] {
  const { system, module: zfsModule, packages, arc, disks, pools, timer, stateMount } = observation
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
      'Mounted datasets',
      pools.detail === null ? 'inspected pool not imported' : pools.detail.mounted.join(', ') || 'none',
    ],
    [
      'Top-level datasets',
      pools.detail === null
        ? 'inspected pool not imported'
        : pools.detail.topLevel
            .map(
              dataset =>
                `${dataset.name} · GUID ${dataset.guid} · mountpoint ${dataset.mountpoint.value} (${dataset.mountpoint.source}) · canmount ${dataset.canmount.value} (${dataset.canmount.source}) · ${dataset.mounted ? 'mounted' : 'not mounted'}`,
            )
            .join(', ') || 'none',
    ],
    [
      'State mount',
      stateMount === null
        ? `nothing reported mounted at ${STATE_MOUNTPOINT}`
        : `${stateMount.source} · ${stateMount.fstype} · root ${stateMount.fsroot} · kernel mount table, read just now`,
    ],
    ['Scrub timer', `${timer.enablement} · ${timer.activation}`],
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

function hostSummary({ observation, target }: PlanPreview): string {
  const { system, module: zfsModule, pools, disks } = observation
  const data = diskOf(disks, target.dataVolumeId)
  const module =
    zfsModule === null ? 'no ZFS module' : `ZFS module ${zfsModule.version} ${zfsModule.loaded ? 'loaded' : 'not loaded'}`
  return [
    system.kernel,
    module,
    `imported pools ${pools.imported.map(pool => pool.name).join(', ') || 'none'}`,
    `data volume ${data === null ? 'not found' : gib(data.sizeBytes)}`,
  ].join(' · ')
}

function prerequisitesScreen(plan: PrerequisitePlan): ApprovalScreen {
  const { arc, install, expectedPool } = plan
  const details: Details = {
    'install-packages': install.map(change => `${change.name} ${change.version} (${change.architecture})`).join(', '),
    'write-arc': `${ZFS_SPEC.arc.file} limits the ARC to ${arc.maxBytes} bytes (${gib(arc.maxBytes)}, ${arc.percent}% of ${gib(arc.memoryBytes)})`,
    'load-module': 'load the packaged ZFS kernel module',
    'apply-arc': `set the running ARC limit to ${arc.maxBytes} bytes`,
  }
  const lasting = [
    install.length > 0
      ? 'Package scripts may load the module and start ZFS services, which Qiln does not control.'
      : null,
    expectedPool === null
      ? null
      : `Installing packages may import the recorded pool (GUID ${expectedPool}), so its state is recorded as unknown until a later step observes it.`,
  ].filter((note): note is string => note !== null)
  return {
    title: 'Proposed prerequisites (applied only after approval)',
    steps: stepsOf(actionsOf(plan), ZFS_LABELS, details),
    covers:
      'Later prerequisite steps that install no further packages and keep this ARC limit continue without a new prompt; anything else is shown and approved again.',
    stays: 'No pool is created, imported, or exported by this plan.',
    lasting: lasting.length === 0 ? undefined : lasting.join(' '),
  }
}

function createScreen(plan: CreatePlan): ApprovalScreen {
  const names = datasetNamesOf(plan.pool)
  const details: Details = {
    'create-pool': `${plan.pool} on ${plan.disk.path} (${plan.disk.volumeId}, ${gib(plan.disk.sizeBytes)}) · one whole-disk vdev, ashift ${plan.ashift}`,
    'create-datasets': `${names.state} (mountpoint ${STATE_MOUNTPOINT}, canmount=noauto) and ${names.incus} (left for Incus to manage)`,
    'enable-scrub': `${plan.scrubTimer}, the packaged monthly timer`,
    'mount-state': `${names.state} at ${STATE_MOUNTPOINT}`,
  }
  return {
    title: 'Proposed storage (applied only after approval)',
    steps: stepsOf(actionsOf(plan), ZFS_LABELS, details),
    stays: 'Nothing else is mounted, and nothing is forced, wiped, or repaired.',
    lasting: `${NO_REDUNDANCY} ${AFTER_REBOOT}`,
    notEstablished: `${NO_BOOT_IMPORT} ${ACTIVATION}`,
  }
}

function importScreen(plan: ImportPlan): ApprovalScreen {
  const names = datasetNamesOf(plan.pool)
  const details: Details = {
    'import-pool': `${plan.pool} (GUID ${plan.guid}) from ${plan.disk.member}; it must hold exactly ${names.state} and ${names.incus} with their recorded GUIDs${plan.imported ? '. Already imported, so this step records and verifies it' : ''}`,
    'enable-scrub': `${plan.scrubTimer}, the packaged monthly timer`,
    'mount-state': `${names.state} at ${STATE_MOUNTPOINT}`,
  }
  return {
    title: plan.mountOnly
      ? 'Proposed mount (applied only after approval)'
      : 'Proposed storage (applied only after approval)',
    steps: stepsOf(actionsOf(plan), ZFS_LABELS, details),
    stays: 'Nothing else is mounted, and nothing is forced or renamed.',
    lasting: plan.mountOnly ? AFTER_REBOOT : `${NO_REDUNDANCY} ${AFTER_REBOOT}`,
    notEstablished: plan.mountOnly ? ACTIVATION : `${NO_BOOT_IMPORT} ${ACTIVATION}`,
  }
}

function exportScreen(plan: ExportPlan): ApprovalScreen {
  const details: Details = {
    'unmount-state': `${datasetNamesOf(plan.pool).state} without force`,
    'export-pool': `${plan.pool} (GUID ${plan.guid}) without force, after disabling ${plan.scrubTimer}`,
  }
  return {
    title: 'Proposed export (applied only after approval)',
    steps: stepsOf(actionsOf(plan), ZFS_LABELS, details),
    stays:
      'Other datasets and the data volume. The step is refused before any change if another dataset is mounted or a scrub or resilver is running.',
  }
}

function screenOf(plan: ApprovedPlan): ApprovalScreen {
  switch (plan.kind) {
    case 'prerequisites':
      return prerequisitesScreen(plan)
    case 'create':
      return createScreen(plan)
    case 'import':
      return importScreen(plan)
    case 'export':
      return exportScreen(plan)
  }
}

/**
 * Renders what was observed and what the approval that follows would do. A
 * proposed screen describes a plan only: nothing in it has been applied until
 * that approval.
 */
export function reportPlan(reporter: Reporter, preview: PlanPreview): void {
  const { plan } = preview
  switch (plan.kind) {
    case 'refused':
    case 'reboot':
      reporter.section('Observed on the host (read-only)')
      reporter.facts(hostFacts(preview))
      return
    case 'ready':
      reporter.section('Storage')
      reporter.facts([
        [
          'Pool',
          `${plan.pool} · GUID ${plan.guid} · observed imported and online as a single plain disk on the recorded data volume, holding exactly its recorded datasets, with the state dataset mounted at ${STATE_MOUNTPOINT} (ZFS and the kernel mount table agree) and its monthly scrub timer enabled and active`,
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
    default:
      reportApproval(reporter, hostSummary(preview), screenOf(plan))
  }
}
