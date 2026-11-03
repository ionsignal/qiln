import { INCUS_SPEC, type IncusAction } from '../../../../host/incus/spec'
import { STATE_MOUNTPOINT } from '../../../../host/mount'
import { rangeText } from '../../../../host/incus/idmap'
import { maskedUnits } from '../../../../host/incus/verify'
import { datasetNamesOf } from '../../../../host/zfs/spec'
import { actionsOf, instanceKey } from '../../../../host/incus/types'
import { INCUS_LABELS, reportApproval, stepsOf, type ApprovalScreen } from './steps'
import type { DiagnosticFact } from '../../../../diagnostic/error'
import type {
  AccessPlan,
  ApprovedPlan,
  ClosePlan,
  IdRange,
  InitializePlan,
  Observation,
  OpenPlan,
  PackagesPlan,
  Plan,
  ReleasePlan,
  RepositoryPlan,
} from '../../../../host/incus/types'
import type { Reporter } from '../../../../terminal/reporter'

export interface PlanPreview {
  observation: Observation
  plan: Plan
}

type Details = Partial<Record<IncusAction, string>>

const REPOSITORY_LASTING =
  'The exact-package pins exclude other Incus builds, including security updates, until they are repinned. apt-get update refreshes every configured APT source.'
const GUARD_LASTING = 'The guard makes the daemon service refuse to start unless the recorded state dataset is mounted.'
const GUARD_NOT_ESTABLISHED = 'Protection against an administrator who runs the daemon directly.'

function repositoryLabel(plan: RepositoryPlan): string {
  return plan.add
    ? 'Set up the displayed Zabbly repository and exact-package pins, then refresh APT package lists on the deployment host'
    : 'Refresh APT package lists on the deployment host'
}

/**
 * The wording of the default-no approval that goes with each displayed plan.
 */
export function approvalLabel(plan: ApprovedPlan): string {
  switch (plan.kind) {
    case 'close': {
      const close = 'Close the deployment host to Incus (mask the Incus units and install the AppArmor sysctl override)'
      return plan.repository === null
        ? close
        : `${close}, then ${repositoryLabel(plan.repository).replace(/^[A-Z]/, letter => letter.toLowerCase())}`
    }
    case 'repository':
      return repositoryLabel(plan)
    case 'packages':
      return 'Install the displayed exact Incus package versions and dependencies on the deployment host'
    case 'open': {
      const guard = plan.install ? ' after installing the displayed storage-identity startup guard' : ''
      return plan.retained === null
        ? `Open the deployment host to Incus${guard}: unmask and start the daemon on the recorded state dataset`
        : `Reopen the preserved Incus installation on the recorded state dataset${guard}, without initializing`
    }
    case 'initialize':
      return 'Initialize Incus from the approved preseed on the deployment host'
    case 'access':
      return `Add ${plan.account} to the ${plan.group} group on the deployment host (root-equivalent Incus access)`
    case 'release':
      return 'Stop the displayed Incus instances, then stop and mask Incus on the deployment host'
  }
}

function fileState(file: Observation['repository']['key']): string {
  switch (file.kind) {
    case 'absent':
      return 'absent'
    case 'file':
      return `regular file · SHA-256 ${file.sha256 ?? 'unknown'}`
    case 'other':
      return 'exists but is not a regular file'
  }
}

function accessState({ account, groupExists, member }: Observation['access']): string {
  const { group } = INCUS_SPEC.access
  if (!groupExists) {
    return `group ${group} does not exist`
  }
  return `${account} ${member ? 'is' : 'is not'} a member of ${group} (account database; not a test of SSH forwarding)`
}

/**
 * A null list is a file that could not be read, which is not the same as a
 * readable file that lists no root range.
 */
function rangesState(ranges: readonly IdRange[] | null): string {
  if (ranges === null) {
    return 'unreadable'
  }
  return ranges.map(rangeText).join(', ') || 'no root range'
}

/**
 * The full inventory, shown only when a plan is refused, because that evidence
 * explains the refusal.
 */
function hostFacts(observation: Observation): DiagnosticFact[] {
  const {
    system,
    runtime,
    repository,
    sysctl,
    guard,
    packages,
    software,
    services,
    listeners,
    access,
    idmap,
    zfs,
    stateMount,
    state,
    api,
  } = observation
  const masked = maskedUnits(observation)
  return [
    ['Package architecture', system.packageArchitecture],
    ['Kernel', `${system.kernel} · ${system.machine} (required ${INCUS_SPEC.floors.kernel} or later)`],
    [
      'Runtime',
      `ZFS ${runtime.zfs ?? 'not found'} · ZFS module ${runtime.zfsModule ?? 'not found'} (required ${INCUS_SPEC.floors.zfs} or later) · LXC is read from the running daemon after the open and is not probed offline`,
    ],
    ['IPv4 forwarding', system.ipForward ? 'enabled' : 'disabled'],
    ['Zabbly key file', fileState(repository.key)],
    ['Zabbly source file', fileState(repository.source)],
    ['Incus package preferences', fileState(repository.preferences)],
    [
      'Sysctl override',
      `${fileState(sysctl.override)} · running ${INCUS_SPEC.sysctl.key}=${sysctl.apparmor ?? 'not reported'}`,
    ],
    [
      'Startup guard',
      `expectation ${fileState(guard.expectation)} · check ${fileState(guard.check)} · drop-in ${fileState(guard.dropIn)}`,
    ],
    ['Incus packages', packages.map(item => `${item.name} ${item.version}`).join(', ') || 'none installed'],
    [
      'Related software',
      software.map(item => `${item.name} ${item.version} (${item.architecture})`).join(', ') || 'none installed',
    ],
    [
      'Incus units',
      services.map(item => `${item.unit} ${item.load}/${item.enablement}/${item.activation}`).join(', ') ||
        'none reported',
    ],
    [
      'Masked units',
      masked.map(({ unit, runtime: temporary }) => (temporary ? `${unit} (runtime)` : unit)).join(', ') || 'none',
    ],
    ['TCP listeners', listeners.join(', ') || 'none'],
    ['Incus access', accessState(access)],
    [
      'Subordinate IDs',
      `/etc/subuid ${rangesState(idmap.uid)} · /etc/subgid ${rangesState(idmap.gid)} (root ranges as start:count; read just now)`,
    ],
    ['ZFS pool', zfs.pool === null ? 'not imported' : `${zfs.pool.name} · GUID ${zfs.pool.guid}`],
    [
      'Pool datasets',
      zfs.datasets.map(dataset => `${dataset.name} (${dataset.mounted ? 'mounted' : 'not mounted'})`).join(', ') ||
        'none',
    ],
    [
      'Top-level datasets',
      zfs.topLevel
        .map(
          dataset =>
            `${dataset.name} · GUID ${dataset.guid} · ${dataset.type} · mountpoint ${dataset.mountpoint.value} (${dataset.mountpoint.source}) · canmount ${dataset.canmount.value} (${dataset.canmount.source}) · ${dataset.mounted ? 'mounted' : 'not mounted'}`,
        )
        .join(', ') || 'none',
    ],
    [
      'State mount',
      stateMount === null
        ? `nothing reported mounted at ${STATE_MOUNTPOINT}`
        : `${stateMount.source} · ${stateMount.fstype} · root ${stateMount.fsroot} · kernel mount table, read just now`,
    ],
    [
      'State directory',
      state.empty
        ? 'empty'
        : `not empty · retained Incus metadata ${state.metadata ? 'present' : 'not found'} (entries only, not their contents)`,
    ],
    [
      'Incus API',
      api === null
        ? 'not read; the Incus service is not running, and inspection neither starts units nor reads through a socket that would start it'
        : `server ${api.server.version} · LXC ${api.server.lxc ?? 'not reported'} (daemon-reported) · ${api.server.clustered ? 'clustered' : 'standalone'} · ${api.projects.length} projects · ${api.pools.length} pools · ${api.instances.length} instances · ${api.images} images`,
    ],
  ]
}

function hostSummary({ system, services, api, zfs }: Observation): string {
  const active = services.filter(service => service.activation === 'active').length
  return [
    `${system.kernel} · ${system.packageArchitecture}`,
    `${active} of ${services.length} Incus units active`,
    api === null ? 'daemon not running' : `daemon ${api.server.version}`,
    zfs.pool === null ? 'no pool imported' : `pool ${zfs.pool.name}`,
  ].join(' · ')
}

function repositoryDetails(plan: RepositoryPlan): Details {
  const { uri, suite } = INCUS_SPEC.repository
  const version = INCUS_SPEC.packageVersions[plan.architecture]
  return {
    'add-repository': `${uri} (${suite}) signing key, source, and pins for incus-base and incus-client ${version} (${plan.architecture})`,
    'refresh-lists': 'update every configured APT source, not only Zabbly',
  }
}

function closeScreen(plan: ClosePlan): ApprovalScreen {
  const { units, sysctl } = INCUS_SPEC
  const { repository } = plan
  const details: Details = {
    close: `mask ${units.join(', ')}; ${sysctl.file} sets ${sysctl.key}=${sysctl.value}`,
    ...(repository === null ? {} : repositoryDetails(repository)),
  }
  return {
    title: 'Proposed closing of the host to Incus (applied only after approval)',
    steps: stepsOf(actionsOf(plan), INCUS_LABELS, details),
    stays:
      'Packages, pools, mounts, and every other unit and file. incus-lxcfs.service is not masked, and package scripts start it.',
    lasting: `Units stay masked, including incus-startup, so the host does not stop Incus instances when it halts.${repository === null ? '' : ` ${REPOSITORY_LASTING}`}`,
    notEstablished:
      'Masks do not stop an administrator who runs the daemon directly, and containers starting with the AppArmor restriction enabled is not established.',
  }
}

function repositoryScreen(plan: RepositoryPlan): ApprovalScreen {
  return {
    title: 'Proposed repository and package pins (applied only after approval)',
    steps: stepsOf(actionsOf(plan), INCUS_LABELS, repositoryDetails(plan)),
    stays: 'Packages, pools, mounts, and units; no package is installed.',
    lasting: REPOSITORY_LASTING,
    notEstablished: 'That the pinned builds are installable; the package step checks that.',
  }
}

function packagesScreen(plan: PackagesPlan): ApprovalScreen {
  const details: Details = {
    'install-packages': plan.install.map(change => `${change.name} ${change.version}`).join(', '),
  }
  return {
    title: 'Proposed packages (applied only after approval)',
    steps: stepsOf(actionsOf(plan), INCUS_LABELS, details),
    stays: 'No unit is opened and no pool is touched. Containers only; the VM stack is out of scope.',
    lasting:
      'The package sysctls apply host-wide. Purging the Incus packages deletes /var/lib/incus (the state dataset), which Qiln cannot prevent.',
    notEstablished:
      'Runtime readiness. A package script that unmasks a unit or starts the daemon is detected afterwards, not prevented.',
  }
}

/**
 * The open and, when it is not installed yet, the storage-identity guard that
 * precedes it under the same approval.
 */
function openScreen(plan: OpenPlan): ApprovalScreen {
  const { retained } = plan
  const { guard, idmap, open } = INCUS_SPEC
  const units = open.units.join(', ')
  const writes = 'The daemon writes its metadata to the state dataset when it opens.'
  const guardDetail = `${guard.expectationFile}, ${guard.checkFile}, and ${guard.dropInFile} for pool ${plan.pool} (GUID ${plan.guid})`
  if (retained === null) {
    return {
      title: 'Proposed open (applied only after approval)',
      steps: stepsOf(actionsOf(plan), INCUS_LABELS, {
        guard: guardDetail,
        open: `unmask and start ${units}; the state directory (${datasetNamesOf(plan.pool).state} at ${STATE_MOUNTPOINT}) must be empty and each subordinate-ID file must list a root range of at least ${idmap.minimum} IDs`,
      }),
      stays:
        'Packages, pools, and instances. Nothing is initialized, the other Incus units stay masked, and Qiln writes no file but the guard files.',
      lasting: `${GUARD_LASTING} ${writes}`,
      notEstablished: `Initialization, which needs its own approval. ${GUARD_NOT_ESTABLISHED}`,
    }
  }
  return {
    title: 'Proposed reopen of the preserved installation (applied only after approval)',
    steps: stepsOf(actionsOf(plan), INCUS_LABELS, {
      guard: guardDetail,
      open: `reopen the installation preserved by deployment ${retained.origin} (server certificate SHA-256 ${retained.identity.certificateFingerprint.slice(0, 12)}); its retained metadata and every recorded subordinate-ID root range must be present`,
    }),
    stays:
      'Packages, pools, and instances. Nothing is initialized, no instance is started, and Qiln writes no file but the guard files.',
    lasting: `${GUARD_LASTING} ${writes} A daemon of a different version could migrate the retained database, which is why the recorded package versions are required first.`,
    notEstablished: `That the preserved workloads work. ${GUARD_NOT_ESTABLISHED}`,
  }
}

function initializeScreen(plan: InitializePlan): ApprovalScreen {
  const { network } = INCUS_SPEC
  return {
    title: 'Proposed initialization (applied only after approval)',
    steps: stepsOf(actionsOf(plan), INCUS_LABELS, {
      initialize: `register pool ${plan.pool} (GUID ${plan.guid}) on ${datasetNamesOf(plan.pool).incus} and the managed bridge ${network.name} (${network.subnet})`,
    }),
    stays:
      'The default profile, the state dataset, and the local-only API (no remote listener). No image, instance, or project is created.',
    lasting: 'Initialization is not atomic, and Qiln never relies on a rollback.',
    notEstablished: 'Runtime readiness.',
  }
}

function accessScreen(plan: AccessPlan): ApprovalScreen {
  return {
    title: 'Proposed socket access (applied only after approval)',
    steps: stepsOf(actionsOf(plan), INCUS_LABELS, { 'grant-access': `add ${plan.account} to ${plan.group}` }),
    stays: 'Socket permissions, SSH configuration, other groups, and other accounts.',
    lasting:
      'Members have root-equivalent authority over Incus and the host. Qiln never removes the membership, and it applies to new SSH connections only.',
    notEstablished: 'That SSH forwarding to the socket works; the first new connection that uses it shows that.',
  }
}

function releaseScreen(plan: ReleasePlan): ApprovalScreen {
  const { stopTimeoutSeconds } = INCUS_SPEC.release
  return {
    title: 'Proposed release (applied only after approval)',
    steps: stepsOf(actionsOf(plan), INCUS_LABELS, {
      'stop-workloads': `${plan.instances.map(instanceKey).join(', ') || 'no instances'} set not to autostart and stopped gracefully (${stopTimeoutSeconds} seconds each), never forced; the host must still match this inventory, and ephemeral instances are refused`,
      release: `every Incus unit masked persistently, then the sockets and services stopped; pool ${plan.pool} (GUID ${plan.guid}) stays imported for the separate ZFS export`,
    }),
    stays: 'Packages and the pool. Qiln does not query Incus afterwards.',
    lasting: 'boot.autostart=false stays set on each instance, and Incus stays stopped and masked until a later prepare reopens it.',
  }
}

function screenOf(plan: ApprovedPlan): ApprovalScreen {
  switch (plan.kind) {
    case 'close':
      return closeScreen(plan)
    case 'repository':
      return repositoryScreen(plan)
    case 'packages':
      return packagesScreen(plan)
    case 'open':
      return openScreen(plan)
    case 'initialize':
      return initializeScreen(plan)
    case 'access':
      return accessScreen(plan)
    case 'release':
      return releaseScreen(plan)
  }
}

/**
 * Renders what was observed and what the approval that follows would do. A
 * proposed screen describes a plan only: nothing in it has been applied until
 * that approval.
 */
export function reportPlan(reporter: Reporter, { observation, plan }: PlanPreview): void {
  switch (plan.kind) {
    case 'refused':
      reporter.section('Observed on the host (read-only)')
      reporter.facts(hostFacts(observation))
      return
    case 'ready':
      reporter.section('Incus baseline')
      reporter.facts([
        [
          'Incus',
          `pool ${plan.pool} · GUID ${plan.guid} · the pinned packages, local Unix-socket API, pool, bridge, recorded state mount, and administrator group membership match the baseline. The default profile, instances, and images are not part of this check, and SSH forwarding to the socket was not tested.`,
        ],
      ])
      return
    case 'stopped':
      reporter.section('Incus release')
      reporter.facts([
        [
          'Incus',
          'every Incus unit was observed inactive, and a verified release is already retained, so there is nothing to release. This is point-in-time: nothing was run or recorded.',
        ],
      ])
      return
    default:
      reportApproval(reporter, hostSummary(observation), screenOf(plan))
  }
}
