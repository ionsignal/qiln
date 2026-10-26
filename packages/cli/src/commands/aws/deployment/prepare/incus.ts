import { readPreseed } from '../../../../host/incus/preseed'
import { RECIPE } from '../../../../host/incus/recipe'
import { INCUS_SPEC } from '../../../../host/incus/spec'
import type { DiagnosticFact } from '../../../../diagnostic/error'
import type {
  AccessPlan,
  ApprovedPlan,
  InitializePlan,
  Observation,
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
    case 'repository':
      return plan.add
        ? 'Add the displayed Zabbly repository and refresh APT package lists on the deployment host'
        : 'Refresh APT package lists on the deployment host'
    case 'packages':
      return 'Install the displayed Incus packages on the deployment host'
    case 'initialize':
      return 'Initialize Incus from the displayed preseed on the deployment host'
    case 'access':
      return `Add ${plan.account} to the ${plan.group} group on the deployment host (root-equivalent Incus access)`
    case 'release':
      return 'Stop Incus on the deployment host'
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

function hostFacts({ observation }: PlanPreview): DiagnosticFact[] {
  const { system, repository, packages, services, listeners, access, zfs, api } = observation
  return [
    ['Package architecture', system.packageArchitecture],
    ['IPv4 forwarding', system.ipForward ? 'enabled' : 'disabled'],
    ['Zabbly key file', fileState(repository.key)],
    ['Zabbly source file', fileState(repository.source)],
    ['Incus packages', packages.map(item => `${item.name} ${item.version}`).join(', ') || 'none installed'],
    [
      'Incus units',
      services.map(item => `${item.unit} ${item.load}/${item.enablement}/${item.activation}`).join(', ') ||
        'none reported',
    ],
    ['TCP listeners', listeners.join(', ') || 'none'],
    ['Incus access', accessState(access)],
    ['ZFS pool', zfs.pool === null ? 'not imported' : `${zfs.pool.name} · GUID ${zfs.pool.guid}`],
    [
      'Pool datasets',
      zfs.datasets.map(dataset => `${dataset.name} (${dataset.mounted ? 'mounted' : 'not mounted'})`).join(', ') ||
        'none',
    ],
    [
      'Incus API',
      api === null
        ? 'not read; no Incus socket is active, and Qiln does not start units'
        : `server ${api.server.version} · ${api.projects.length} projects · ${api.pools.length} pools · ${api.instances.length} instances · ${api.images} images`,
    ],
  ]
}

function reportRepository(reporter: Reporter, plan: RepositoryPlan): void {
  const { repository } = INCUS_SPEC
  reporter.section('Proposed repository (applied only after approval)')
  reporter.facts([
    [
      'Repository',
      `${repository.uri} · suite ${repository.suite} · component ${repository.component} · architecture ${plan.architecture}`,
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
      'Files',
      plan.add ? 'an absent file would be written, the key first' : 'both files already hold the approved bytes',
    ],
    ['Package lists', 'refreshed with apt-get update, which updates every configured APT source and not only this one'],
  ])
}

function reportPackages(reporter: Reporter, plan: PackagesPlan): void {
  reporter.section('Proposed packages (applied only after approval)')
  reporter.facts([
    ['Packages', plan.install.map(change => `${change.name} ${change.version} (${change.architecture})`).join(', ')],
    ['Count', String(plan.install.length)],
    ['Refused if installed', INCUS_SPEC.excluded.join(', ')],
    ['Units', 'package-enabled units may start as part of the packages’ own configuration'],
  ])
}

function reportInitialize(reporter: Reporter, plan: InitializePlan): void {
  const document = readPreseed(plan.preseed.yaml)
  const [pool] = document?.storage_pools ?? []
  const [network] = document?.networks ?? []
  const [profile] = document?.profiles ?? []
  const entries = (settings: Record<string, string>) =>
    Object.entries(settings)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ')
  reporter.section('Proposed initialization (applied only after approval)')
  reporter.facts([
    ['Preseed', `${plan.preseed.yaml.length} bytes · SHA-256 ${plan.preseed.sha256} · retained exactly as approved`],
    ['Pool', `${plan.pool} · GUID ${plan.guid} · registered as an existing ZFS pool`],
    ['Pool settings', pool === undefined ? 'unreadable' : entries(pool.config)],
    ['Bridge', network === undefined ? 'unreadable' : `${network.name} · ${entries(network.config)}`],
    [
      'Default profile',
      profile === undefined
        ? 'unreadable'
        : Object.entries(profile.devices)
            .map(([name, device]) => `${name}: ${entries(device)}`)
            .join(' · ') || 'no devices',
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
  reporter.section('Proposed release (applied only after approval)')
  reporter.facts([
    ['Pool', `${plan.pool} · GUID ${plan.guid} · stays imported for the separate ZFS export`],
    ['Running instances', running === undefined ? 'unknown; the Incus API was not read' : String(running)],
    [
      'Stop order',
      'instances in order through the startup unit and the daemon, then the user and main sockets, then the services',
    ],
  ])
}

const NOTICES: Record<ApprovedPlan['kind'], string> = {
  repository:
    'Approval authorizes only the listed steps, each one fenced remote script followed by a fresh inspection that must agree. ' +
    'The stable channel is not a version pin: exact package versions are frozen only by the later package approval. ' +
    'The key is downloaded once on the host, used only when its digest matches, and never replaced. No package is installed by this plan. ' +
    'A failed or cancelled step is not replayed, resumed, or rolled back, and interrupted work may already have completed.',
  packages:
    'Approval authorizes only the listed package versions, re-simulated just before the install, with no upgrades or removals. ' +
    'Installing packages can start Incus units as part of the package’s own configuration, which Qiln does not control. ' +
    'Nothing is initialized by this plan, and the initialization needs its own approval after a fresh inspection. ' +
    'A failed or cancelled step is not replayed, resumed, or rolled back, and interrupted work may already have completed.',
  initialize:
    'Initialization is not an atomic transaction, and Qiln never relies on a rollback. It runs only against a pristine daemon and a pool without Incus datasets, ' +
    'planned again after approval and checked again just before it runs, and nothing is forced, wiped, or converged. A failed or cancelled step is not replayed, resumed, or rolled back, and interrupted work may already have ' +
    'changed the daemon and the pool. Restoration of retained Incus state is not supported, and approval does not establish runtime readiness.',
  access:
    'Approval authorizes only adding the displayed account to the displayed group, one fenced remote script followed by a fresh inspection that must agree. ' +
    'Membership is read from the account database, so it shows that the grant was recorded and not that SSH forwarding works: only the first new connection that uses it proves that. ' +
    'Qiln never changes socket permissions, SSH configuration, or other groups, and never removes the membership. ' +
    'A failed or cancelled step is not replayed, resumed, or rolled back, and interrupted work may already have completed.',
  release:
    'Approval authorizes stopping Incus only, one fenced remote script followed by a fresh inspection that must agree. Qiln never starts units, ' +
    'so Incus stays stopped until an operator restarts it outside Qiln. A failed or cancelled step is not replayed, resumed, or rolled back, ' +
    'and interrupted work may already have completed.',
}

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
          `pool ${plan.pool} · GUID ${plan.guid} · the approved packages, local Unix-socket API, pool, bridge, and default profile were observed matching the retained preseed, and the administrator account was observed in ${INCUS_SPEC.access.group}. Instances and images are not part of this check, and SSH forwarding to the socket was not tested.`,
        ],
      ])
      return
    case 'stopped':
      reporter.section('Incus release')
      reporter.facts([
        [
          'Incus',
          'every Incus unit was observed inactive, so there is nothing to stop. This is point-in-time: no unit was changed and no step was run. Only the observation is retained as evidence.',
        ],
      ])
      return
    case 'repository':
      reportRepository(reporter, plan)
      break
    case 'packages':
      reportPackages(reporter, plan)
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
  reporter.notice(NOTICES[plan.kind])
}
