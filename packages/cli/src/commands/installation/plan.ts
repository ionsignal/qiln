import { INSTALLER_SPEC } from '../../install/spec'
import { isEmpty, type ConfigurePlan } from '../../install/journal/types'
import type { DiagnosticFact } from '../../diagnostic/error'
import type { ImageSource } from '../../install/image'
import type { InstallationInputs } from '../../install/types'
import type { Reporter } from '../../terminal/reporter'

export interface PlanPreview {
  plan: ConfigurePlan
  inputs: InstallationInputs
  source: ImageSource
}

const NOTICE =
  'Approval authorizes only the listed changes. Each Incus change is one fenced request followed by a fresh observation that must agree, ' +
  'and the whole installation is observed again afterwards. The plan is derived again from the host after approval and must be unchanged before anything is recorded. ' +
  'A failed or cancelled step is not replayed, resumed, or rolled back, and interrupted work may already have completed. ' +
  'The selected image is trusted guest code: Qiln has not established its provenance, authenticity, guest compatibility, or bootstrap readiness. ' +
  'No service is started.'

/**
 * The wording of the default-no approval that goes with the displayed plan.
 */
export function approvalLabel(plan: ConfigurePlan): string {
  return plan.image.replace === null
    ? 'Apply the displayed installation plan to the Incus daemon'
    : 'Apply the displayed installation plan, including deleting the displayed image, on the Incus daemon'
}

/**
 * Renders what an approved plan would change. Nothing described here has been
 * applied until the approval that follows it. An installation that already
 * matches has nothing to display.
 */
export function reportPlan(reporter: Reporter, { plan, inputs, source }: PlanPreview): void {
  if (isEmpty(plan)) {
    return
  }
  const { layout } = inputs
  const { image } = plan
  const { name, imageAlias, sourceMountPath } = INSTALLER_SPEC.orchestrator
  const facts: DiagnosticFact[] = [
    [
      'Image',
      `${plan.fingerprint} · ${source.kind === 'split' ? 'staged split artifacts' : 'existing local image; never pulled or replaced'}`,
    ],
  ]
  if (image.replace !== null) {
    facts.push([
      'Image deletion',
      `${image.replace.fingerprint} · destructive · the managed alias ${imageAlias} targets different content · aliases removed with it: ${image.replace.aliases.join(', ') || 'none'}`,
    ])
  }
  if (image.import) {
    facts.push(['Image import', `the staged artifacts are uploaded under the managed alias ${imageAlias}`])
  }
  if (image.alias) {
    facts.push(['Image alias', `${imageAlias} is created for the image already in the store`])
  }
  if (plan.pin) {
    facts.push(['Image pin', 'the full fingerprint is written to the installation record'])
  }
  if (plan.network) {
    facts.push(['Network', `create ${layout.network.name} · ${layout.network.ipv4Subnet} · managed bridge`])
  }
  if (plan.volume) {
    facts.push([
      'PostgreSQL volume',
      `create ${layout.postgres.volumeName} · ${layout.postgres.config.size} · persistent custom volume in ${layout.pool.name}`,
    ])
  }
  if (plan.instance) {
    facts.push(['Orchestrator', `create ${name} · ${inputs.architecture.incus} container · created stopped`])
  }
  switch (plan.credentials) {
    case 'generate':
      facts.push(['Local credentials', 'four protected credential files are generated from the validated roster; values are never shown'])
      break
    case 'roster':
      facts.push(['Local credentials', 'only the retained authorized-key roster is replaced'])
      break
    case 'reuse':
      facts.push(['Local credentials', 'the complete retained credential set is reused'])
      break
  }
  if (plan.deliver) {
    facts.push(['Instance credentials', 'the four credentials are delivered in one guarded complete instance update'])
  }
  facts.push(
    [
      'Source device',
      `${inputs.sourceRoot} → ${sourceMountPath} · writable shifted disk; the instance can modify the host checkout`,
    ],
    ['Authority', 'uses the invoking developer’s Incus socket access, which is root-equivalent authority on the host'],
    ['Final state', `${name} · configured · stopped`],
  )
  reporter.section('Proposed installation changes (applied only after approval)')
  reporter.facts(facts)
  reporter.space()
  reporter.notice(NOTICE)
}
