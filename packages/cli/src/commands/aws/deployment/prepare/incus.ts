import { RECIPE } from '../../../../host/incus/recipe'
import { INCUS_SPEC, packagePins } from '../../../../host/incus/spec'
import { STATE_MOUNTPOINT } from '../../../../host/mount'
import { guardOf } from '../../../../host/incus/activation'
import { isPinned } from '../../../../host/incus/baseline'
import { rangeText } from '../../../../host/incus/idmap'
import { readPreseed } from '../../../../host/incus/preseed'
import { instanceKey } from '../../../../host/incus/types'
import { maskedUnits } from '../../../../host/incus/verify'
import { datasetNamesOf } from '../../../../host/zfs/spec'
import type { DiagnosticFact } from '../../../../diagnostic/error'
import type {
  AccessPlan,
  ApprovedPlan,
  ClosePlan,
  GuardPlan,
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

/**
 * The wording of the default-no approval that goes with each displayed plan.
 */
export function approvalLabel(plan: ApprovedPlan): string {
  switch (plan.kind) {
    case 'close':
      return 'Close the deployment host to Incus: mask the displayed Incus units so no package can start them, and install the displayed sysctl override that keeps the AppArmor restriction enabled'
    case 'guard':
      return 'Install the displayed storage-identity startup guard on the deployment host'
    case 'repository':
      return plan.add
        ? 'Install the missing displayed Zabbly repository and Incus package-pin files, then refresh APT package lists on the deployment host'
        : 'Refresh APT package lists on the deployment host'
    case 'packages':
      return 'Install the displayed exact Incus package versions and dependencies on the deployment host'
    case 'open':
      return plan.retained === null
        ? 'Open the deployment host to Incus: unmask and start the Incus daemon units on the recorded state dataset'
        : 'Reopen the preserved Incus installation: unmask and start the Incus daemon units on the recorded state dataset, without initializing'
    case 'initialize':
      return 'Initialize Incus from the displayed preseed on the deployment host'
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

function hostFacts({ observation }: PlanPreview): DiagnosticFact[] {
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

function reportClose(reporter: Reporter, plan: ClosePlan): void {
  const { units, sysctl } = INCUS_SPEC
  reporter.section('Proposed closing of the host to Incus (applied only after approval)')
  reporter.facts([
    [
      'Units',
      `${units.join(', ')} · masked persistently, so package scripts that honor masks neither enable nor start them · a mask does not stop a unit that is already active, which is refused`,
    ],
    [
      'Not masked',
      'incus-lxcfs.service · the packaged daemon unit requires it, and it mounts its own filesystem at /var/lib/incus-lxcfs and not the Incus state directory (read from the packaged unit file). The package scripts therefore enable and start it when they install, so the host is not entirely quiet while the packages install, and containers need it running',
    ],
    [
      'Sysctl override',
      `${sysctl.file} · SHA-256 ${plan.sysctl.sha256} · sets ${sysctl.key}=${sysctl.value} to keep the AppArmor restriction on unprivileged user namespaces enabled · written only when absent; an existing file must hold exactly the approved bytes · it sorts after the package file 50-incus.conf, so it wins when the package script restarts systemd-sysctl`,
    ],
    [
      'Package sysctls',
      'the Incus packages ship /usr/lib/sysctl.d/50-incus.conf (read from the extracted 1:7.5.1 incus-base package, not yet confirmed on this host), and their postinst restarts systemd-sysctl, so its limits for inotify, AIO, kernel keys, neighbor tables, and vm.max_map_count apply host-wide once the packages install. They are accepted, disclosed here, and not undone. Its AppArmor line is overridden by the file above',
    ],
    [
      'Scope',
      'containers only: incus-base and incus-client. The VM-capable incus meta-package, incus-ui-canonical, and incus-extra are out of scope and refused if installed',
    ],
    [
      'Consequence',
      'incus-startup.service stays masked, so the host does not stop Incus instances when it halts. The release performed by remove is the designed way to stop them',
    ],
    ['Order', 'this runs before the packages and before the state dataset is mounted, so no package is installed against mounted Incus state'],
    ['Unchanged', 'packages, pools, mounts, every other unit, and every file except the sysctl override'],
  ])
}

function reportGuard(reporter: Reporter, plan: GuardPlan): void {
  const { guard } = INCUS_SPEC
  const { expectation, check, dropIn } = guardOf(plan)
  reporter.section('Proposed storage-identity guard (applied only after approval)')
  reporter.facts([
    [
      'Expectation file',
      `${guard.expectationFile} · SHA-256 ${expectation.sha256} · pool ${plan.pool} · GUID ${plan.guid} · state dataset GUID ${plan.datasets.state} · written only when absent`,
    ],
    [
      'Startup check',
      `${guard.checkFile} · SHA-256 ${check.sha256} · compares the filesystem mounted at ${STATE_MOUNTPOINT} with the expectation file, and never installs, imports, repairs, or queries Incus`,
    ],
    [
      'Service drop-in',
      `${guard.dropInFile} · SHA-256 ${dropIn.sha256} · runs the startup check before the daemon service starts, and fails the service when it refuses`,
    ],
    ['Order', 'installed once the state dataset is mounted and before the daemon is opened'],
    ['Unchanged', 'the unit masks, packages, pools, mounts, and every other unit and configuration file'],
  ])
}

function reportRepository(reporter: Reporter, plan: RepositoryPlan): void {
  const { repository } = INCUS_SPEC
  reporter.section('Proposed repository and package pins (applied only after approval)')
  reporter.facts([
    [
      'Repository',
      `${repository.uri} · suite ${repository.suite} · component ${repository.component} · architecture ${plan.architecture} · moving stable repository`,
    ],
    [
      'Selected package pins',
      packagePins(plan.architecture).map(pin => `${pin.name}=${pin.version} (${pin.architecture})`).join(', '),
    ],
    [
      'Signing key',
      `${plan.key.url} · SHA-256 ${plan.key.sha256} · OpenPGP fingerprint ${repository.fingerprint} (review metadata; the host verifies the file digest)`,
    ],
    [
      'Key file',
      `${repository.keyFile} · written only when absent; an existing file must hold exactly the approved bytes`,
    ],
    [
      'Source file',
      `${repository.sourceFile} · SHA-256 ${plan.source.sha256} · written only when absent; an existing file must hold exactly the approved bytes`,
    ],
    [
      'Preferences file',
      `${repository.preferencesFile} · SHA-256 ${plan.preferences.sha256} · written only when absent; an existing file must hold exactly the approved bytes`,
    ],
    [
      'APT selection',
      'the exact Incus builds receive priority 1000; other versions receive priority -1. This excludes other builds from normal APT selection, does not authorize a downgrade, and does not pin ZFS or the operating system',
    ],
    [
      'Files',
      plan.add ? 'missing files would be written; the key and preferences precede the source' : 'all three files already hold the approved bytes',
    ],
    ['Package lists', 'refreshed with apt-get update, which updates every configured APT source and not only this one'],
  ])
}

function reportPackages(reporter: Reporter, plan: PackagesPlan): void {
  reporter.section('Proposed packages (applied only after approval)')
  reporter.facts([
    ['Packages', plan.install.map(change => `${change.name} ${change.version} (${change.architecture})`).join(', ')],
    ['Count', String(plan.install.length)],
    ['Scope', 'containers only; the VM stack is out of scope'],
    ['Refused if installed', INCUS_SPEC.excluded.join(', ')],
    [
      'Version policy',
      'incus-base and incus-client must match the selected full native package versions. Missing exact builds or different installed versions refuse; no upgrade, downgrade, or substitute is offered',
    ],
    [
      'Units',
      'the host is closed, so the Incus units are masked while the packages install; package scripts that try to start them may fail, and a failed install is never replayed. incus-lxcfs.service is not masked, and the package scripts enable and start it',
    ],
    [
      'Closed-host check',
      'the install is verified only if every Incus unit is still persistently masked and inactive and the AppArmor restriction is not 0 afterwards. A package script that undoes this is detected, not prevented, and leaves the step unverified',
    ],
    [
      'Purge',
      'apt purge of the Incus packages deletes /var/lib/incus, which is the mounted state dataset. Packaging cannot prevent it, so it is unsupported. Qiln only detects the damage later, when retained metadata is found missing',
    ],
  ])
}

function reportOpen(reporter: Reporter, plan: OpenPlan): void {
  const names = datasetNamesOf(plan.pool)
  const { retained } = plan
  const { minimum } = INCUS_SPEC.idmap
  const units: DiagnosticFact = [
    'Units',
    `unmask and start ${INCUS_SPEC.open.units.join(', ')} · the other Incus units stay masked, and nothing is enabled`,
  ]
  const identity: DiagnosticFact = [
    'Identity',
    `${names.state} · GUID ${plan.datasets.state} must be the filesystem mounted at ${STATE_MOUNTPOINT}, which the startup check verifies against the expectation file just before the units start`,
  ]
  if (retained === null) {
    reporter.section('Proposed open (applied only after approval)')
    reporter.facts([
      units,
      identity,
      [
        'State directory',
        'must be empty: this opens a fresh installation only, and retained Incus state is never opened through this plan',
      ],
      [
        'Subordinate IDs',
        `/etc/subuid and /etc/subgid must each list a root range of at least ${minimum} IDs, observed just now and checked again on the host just before the units start. Qiln never edits either file`,
      ],
      [
        'Daemon',
        'starting the daemon initializes its metadata in the state directory. No project, pool, network, image, or instance is created by this step.',
      ],
    ])
    return
  }
  const { allocations } = retained.baseline
  reporter.section('Proposed reopen of the preserved installation (applied only after approval)')
  reporter.facts([
    units,
    identity,
    [
      'Preserved installation',
      `established by deployment ${retained.origin} · server certificate SHA-256 ${retained.identity.certificateFingerprint} · retained preseed SHA-256 ${retained.preseed.sha256} · reopened, never initialized`,
    ],
    [
      'Recorded software',
      `${retained.baseline.packages.filter(item => isPinned(item.name)).length} pinned packages (${retained.baseline.architecture}) at their recorded versions, observed matching just now · Incus packages also match this recipe’s exact pins · ZFS is judged by version floors and not pinned`,
    ],
    [
      'Recorded subordinate IDs',
      `/etc/subuid ${rangesState(allocations.uid)} · /etc/subgid ${rangesState(allocations.gid)} · every recorded root range (start:count) must be listed exactly, checked again on the host just before the units start · extra ranges are permitted · Qiln never edits either file`,
    ],
    [
      'State directory',
      'must hold the retained Incus metadata entries (checked by presence only, not contents): a missing one refuses, and Qiln never falls back to a fresh installation',
    ],
    [
      'Daemon',
      'starting the daemon opens the retained database, and a daemon of a different version could migrate it, which is why the recorded versions are required first. Afterwards the server identity, the LXC version the daemon reports, the pool registration, the bridge, and the stopped instances are verified. Nothing is initialized and no instance is started.',
    ],
  ])
}

function reportInitialize(reporter: Reporter, plan: InitializePlan): void {
  const document = readPreseed(plan.preseed.yaml)
  const [pool] = document?.storage_pools ?? []
  const [network] = document?.networks ?? []
  const names = datasetNamesOf(plan.pool)
  const entries = (settings: Record<string, string>) =>
    Object.entries(settings)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ')
  reporter.section('Proposed initialization (applied only after approval)')
  reporter.facts([
    ['Preseed', `${plan.preseed.yaml.length} bytes · SHA-256 ${plan.preseed.sha256} · retained exactly as approved`],
    [
      'Pool',
      `${plan.pool} · GUID ${plan.guid} · registered from the existing, empty dataset ${names.incus} · GUID ${plan.datasets.incus} · ${names.state} stays outside the storage driver`,
    ],
    ['Pool settings', pool === undefined ? 'unreadable' : entries(pool.config)],
    ['Bridge', network === undefined ? 'unreadable' : `${network.name} · ${entries(network.config)}`],
    [
      'Default profile',
      'not configured; it stays as found, and the installation attaches its instance to the pool and bridge explicitly',
    ],
    ['Remote API', 'no listener address is configured; administration is the local Unix socket only'],
    ['Created', 'no image, instance, or project is created'],
  ])
}

function reportAccess(reporter: Reporter, plan: AccessPlan): void {
  reporter.section('Proposed socket access (applied only after approval)')
  reporter.facts([
    ['Account', plan.account],
    ['Group', `${plan.group} · added with usermod -aG, which keeps every other membership`],
    ['Authority', 'members can administer Incus through its Unix socket, which is root-equivalent authority on the host'],
    ['Effect', 'applies to new SSH connections only; the current connection and its sessions keep their groups'],
    ['Unchanged', 'socket permissions, SSH configuration, other groups, and other accounts'],
  ])
}

function reportRelease(reporter: Reporter, observation: Observation, plan: ReleasePlan): void {
  const running = observation.api?.instances.filter(instance => instance.status === 'Running').length
  const { stopTimeoutSeconds } = INCUS_SPEC.release
  reporter.section('Proposed release (applied only after approval)')
  reporter.facts([
    ['Pool', `${plan.pool} · GUID ${plan.guid} · stays imported for the separate ZFS export`],
    [
      'Instances',
      `${plan.instances.map(instanceKey).join(', ') || 'none'} · the inventory observed just now, which the host must still match when the step runs`,
    ],
    ['Running instances', running === undefined ? 'unknown; the Incus API was not read' : String(running)],
    [
      'Autostart',
      'boot.autostart=false is set on each instance with a single-key update, so a reopened daemon never resumes it',
    ],
    [
      'Stop',
      `each instance is stopped gracefully with ${stopTimeoutSeconds} seconds to shut down: never forced and never stateful`,
    ],
    [
      'Daemon',
      'every Incus unit is masked persistently first, then the user and main sockets and then the services are stopped',
    ],
  ])
}

const NOTICES: Record<ApprovedPlan['kind'], string> = {
  close:
    'Approval authorizes only the listed masks and the listed sysctl override file, one fenced remote script followed by a fresh inspection that must agree. ' +
    'A unit that is already active is refused, because a mask does not stop it. The masks keep package scripts that honor them from starting the daemon; they do not stop an administrator who runs the daemon directly. ' +
    'The override file is written only when absent, an existing file must hold exactly the approved bytes, and Qiln never removes it. It pins one AppArmor setting that the package would weaken; the other package sysctls are accepted. Whether containers start with the restriction enabled is not established by preparation. ' +
    'incus-lxcfs.service is deliberately not masked, and the package scripts start it when they install. ' +
    'This runs before the packages and before the state dataset is mounted. Installing packages can still start other units, such as ZFS import units, so an unmounted state dataset is not an inaccessible one, and this ordering has not been qualified against the selected packages. ' +
    'incus-startup.service stays masked, so the host does not stop Incus instances when it halts; the release performed by remove is the designed way to stop them. ' +
    'No package is installed, no pool is touched, and no daemon is started by this plan. A failed or cancelled step is not replayed, resumed, or rolled back, and interrupted work may already have completed.',
  guard:
    'Approval authorizes only the listed guard files, one fenced remote script followed by a fresh inspection that must agree. ' +
    'Existing guard files must already hold exactly the approved bytes and are never overwritten. ' +
    'The startup check compares the mounted state dataset with the expectation file before the daemon service starts. It is a guard against accidental activation and does not stop an administrator who runs the daemon directly. ' +
    'No unit is masked, unmasked, or started and no package is installed by this plan. A failed or cancelled step is not replayed, resumed, or rolled back, and interrupted work may already have completed.',
  repository:
    'Approval authorizes only the listed files and package-list refresh, each step fenced and followed by a fresh inspection that must agree. ' +
    'The stable repository remains a moving channel; the preferences select the displayed full package builds instead. APT metadata and simulation must confirm those exact builds before a separate package approval. ' +
    'Existing files are never overwritten. The key is downloaded once on the host and used only when its digest matches. No package is installed by this plan. ' +
    'Freezing the Incus packages also excludes future updates from normal APT selection until deliberate repinning; explicit administrator overrides remain outside this guard. ' +
    'A failed or cancelled step is not replayed, resumed, or rolled back, and interrupted work may already have completed.',
  packages:
    'Approval authorizes only the listed package versions, re-simulated just before the install, with no upgrades or removals. ' +
    'The host is closed while they install, so package scripts cannot start the masked Incus units, although they do start incus-lxcfs.service. In a normal preparation this runs before the state dataset is mounted, so no package is installed against mounted Incus state. Whether the selected packages install cleanly while the units are masked is observed here and not assumed. ' +
    'Full installed package versions and architectures are checked afterwards, together with the closed host: a package script that unmasks a unit, starts the daemon, or sets the AppArmor restriction to 0 leaves the step unverified, because the daemon’s upstream version label alone is insufficient. ' +
    'Nothing is opened or initialized by this plan, and each needs its own approval after a fresh inspection. ' +
    'A failed or cancelled step is not replayed, resumed, or rolled back, and interrupted work may already have completed.',
  open:
    'Approval authorizes only unmasking and starting the listed units, one fenced remote script followed by a fresh inspection that must agree. ' +
    'The startup check, the empty state directory, and the subordinate-ID root ranges are verified on the host just before the units start, and neither ID file is ever edited. Starting the daemon writes its metadata to the state directory, so the open is treated as touching Incus storage. ' +
    'Nothing is initialized by this plan, and the initialization needs its own approval after a fresh inspection. ' +
    'A failed or cancelled step is not replayed, resumed, or rolled back, and interrupted work may already have completed.',
  initialize:
    'Initialization is not an atomic transaction, and Qiln never relies on a rollback. It runs only against a pristine daemon and a pool holding exactly its root, its state dataset, and an empty storage dataset, ' +
    'planned again after approval and checked again just before it runs, and nothing is forced, wiped, or converged. A failed or cancelled step is not replayed, resumed, or rolled back, and interrupted work may already have ' +
    'changed the daemon and the pool. Retained Incus state is never initialized over: a preserved installation is reopened by its own plan. Approval does not establish runtime readiness.',
  access:
    'Approval authorizes only adding the displayed account to the displayed group, one fenced remote script followed by a fresh inspection that must agree. ' +
    'Membership is read from the account database, so it shows that the grant was recorded and not that SSH forwarding works: only the first new connection that uses it proves that. ' +
    'Qiln never changes socket permissions, SSH configuration, or other groups, and never removes the membership. ' +
    'A failed or cancelled step is not replayed, resumed, or rolled back, and interrupted work may already have completed.',
  release:
    'Approval authorizes two fenced remote scripts, each followed by a fresh inspection that must agree. First every instance of the displayed inventory is set not to start automatically and stopped gracefully, ' +
    'never forced and never stateful, and the step refuses before changing anything if the inventory differs or an instance is ephemeral, because stopping an ephemeral instance deletes it. ' +
    'Then every Incus unit is masked persistently and the sockets and services are stopped, while the pool stays imported. Qiln starts Incus only in the approved open step, ' +
    'so Incus stays stopped and masked on this deployment; a separately prepared successor may reopen the retained installation after its own checks and approval. A failed or cancelled step is not replayed, resumed, or rolled back, ' +
    'and interrupted work may already have completed.',
}

const PRESERVED_OPEN_NOTICE =
  'Approval authorizes only unmasking and starting the listed units, one fenced remote script followed by a fresh inspection that must agree. ' +
  'The startup check, the retained metadata entries, and every recorded subordinate-ID root range are verified on the host just before the units start, and the open is refused rather than falling back to a fresh installation. Neither ID file is ever edited. ' +
  'Starting the daemon opens the retained database and may write to the state directory, so the open is treated as touching Incus storage. ' +
  'The step is verified only when the exact package pins, retained software baseline, server certificate fingerprint, daemon-reported LXC version, standalone server, pool registration, and bridge match, and every instance is stopped. ' +
  'The root-range check does not establish that every retained instance mapping is correct. ' +
  'No workload is started, nothing is initialized or repaired, no credential is rotated, and approval does not establish that the preserved workloads work. ' +
  'A failed or cancelled step is not replayed, resumed, or rolled back, and interrupted work may already have completed.'

/**
 * Renders what was observed and what a later approved step would do. Every
 * proposed section describes a plan only: nothing in it has been applied until
 * the approval that follows it.
 */
export function reportPlan(reporter: Reporter, preview: PlanPreview): void {
  const { observation, plan } = preview
  reporter.section('Observed on the host (read-only)')
  reporter.facts(hostFacts(preview))
  switch (plan.kind) {
    case 'refused':
      return
    case 'ready':
      reporter.section('Incus baseline')
      reporter.facts([
        [
          'Incus',
          `pool ${plan.pool} · GUID ${plan.guid} · the exact pinned packages, local Unix-socket API, pool, and bridge were observed matching the required baseline, the recorded state dataset was observed mounted at ${STATE_MOUNTPOINT}, and the administrator account was observed in ${INCUS_SPEC.access.group}. The default profile, instances, and images are not part of this check, and SSH forwarding to the socket was not tested.`,
        ],
      ])
      return
    case 'stopped':
      reporter.section('Incus release')
      reporter.facts([
        [
          'Incus',
          'every Incus unit was observed inactive, and a verified release is already retained, so there is nothing to release. This is point-in-time: no unit was changed, no step was run, and nothing new is recorded.',
        ],
      ])
      return
    case 'close':
      reportClose(reporter, plan)
      break
    case 'guard':
      reportGuard(reporter, plan)
      break
    case 'repository':
      reportRepository(reporter, plan)
      break
    case 'packages':
      reportPackages(reporter, plan)
      break
    case 'open':
      reportOpen(reporter, plan)
      break
    case 'initialize':
      reportInitialize(reporter, plan)
      break
    case 'access':
      reportAccess(reporter, plan)
      break
    case 'release':
      reportRelease(reporter, observation, plan)
      break
  }
  reporter.space()
  reporter.info(`Recipe revision ${RECIPE.revision} · SHA-256 ${RECIPE.digest}`)
  reporter.space()
  reporter.notice(plan.kind === 'open' && plan.retained !== null ? PRESERVED_OPEN_NOTICE : NOTICES[plan.kind])
}
