import { INSTALLER_SPEC } from '../../installation/spec'
import { INSTALL_STEPS } from './steps'
import { actionsOf, isEmpty, type ConfigurePlan, type InstallAction } from '../../installation/journal/types'
import { reportApproval, stepsOf, type ApprovalScreen, type ApprovalStep } from '../../terminal/approval'
import type { ImageSource } from '../../installation/image'
import type { Ingress } from '../../installation/ingress'
import type { ImageReplacement } from '../../installation/plan'
import type { InstallationInputs } from '../../installation/types'
import type { Reporter } from '../../terminal/reporter'

/**
 * `held` is the image deletion that the first gate of a replacement leaves for
 * its own approval, and null for every other plan. `ingress` is the generated
 * configuration that the instance update would deliver, or null while none is
 * derivable.
 */
export interface PlanPreview {
  plan: ConfigurePlan
  held: ImageReplacement | null
  inputs: InstallationInputs
  source: ImageSource
  ingress: Ingress | null
}

type Details = Partial<Record<InstallAction, string>>

/**
 * The actions that run before the image pin is written.
 */
const BEFORE_PIN: readonly InstallAction[] = ['materialize-checkout', 'import-image', 'delete-image', 'create-alias']
const AUTHORITY = 'The invoking developer’s Incus socket access is root-equivalent authority on the host.'
const IMPORT_NOTE = 'A rejected import stays in the image store without an alias, and Qiln never deletes it.'
const PUBLISH_NOTE =
  'Published ports are forwarded to the orchestrator through NAT proxy devices on the host address, so it sees client addresses. Qiln opens no cloud firewall port, and reachability from outside is not established.'
const INGRESS_NOTE =
  'The ingress configuration, and for a domain target the retained TLS private key, are stored in the instance configuration beside the credentials.'
const TRUSTED =
  'The selected image and the checkout are trusted guest code, and Qiln has not established their provenance or compatibility.'
const DELIVERY_NOT_ESTABLISHED =
  'Delivery to the stopped instance does not establish that services started, that DNS is correct, that the certificate is publicly trusted, or that any port is reachable.'

const LIST_FORMAT = new Intl.ListFormat('en')

const CREDENTIALS = {
  generate: 'generate four protected credential files from the validated roster; values are never shown',
  roster: 'replace only the retained authorized-key roster',
  reuse: 'reuse the complete retained credential set',
} as const satisfies Record<ConfigurePlan['credentials'], string>

/**
 * The wording of the default-no approval that goes with each displayed gate.
 */
export function approvalLabel(plan: ConfigurePlan, held: ImageReplacement | null): string {
  if (held !== null) {
    return 'Import the image, keeping the previous one'
  }
  return plan.image.replace === null
    ? 'Apply the installation plan'
    : 'Delete the previous image and apply the plan'
}

/**
 * The public origin, the advertised SSH endpoint, and the leaf certificate
 * fingerprint of a generated ingress. A target without TLS has no certificate.
 */
export function describeIngress({ origin, host, fingerprint }: Ingress): string {
  const tls = fingerprint === null ? 'plain HTTP, no TLS' : `certificate SHA-256 ${fingerprint}`
  return `${origin} · SSH ${host}:${INSTALLER_SPEC.ingress.ports.gateway} · ${tls}`
}

function detailsOf(plan: ConfigurePlan, inputs: InstallationInputs, ingress: Ingress | null): Details {
  const { layout, architecture, sourceRoot, publish } = inputs
  const { checkout, image } = plan
  const { name, imageAlias } = INSTALLER_SPEC.orchestrator
  const { repository } = INSTALLER_SPEC.checkout
  const published =
    publish === null
      ? ''
      : ` · publishes TCP ${publish.ports.join(', ')} on ${publish.address} through NAT proxy devices`
  const delivered = LIST_FORMAT.format([
    'the four credentials',
    ...(ingress === null ? [] : [`the ingress configuration (${describeIngress(ingress)})`]),
    ...(publish === null ? [] : ['the published port devices']),
  ])
  return {
    ...(checkout === null
      ? {}
      : {
          'materialize-checkout': `${repository} at commit ${checkout.commit} to ${sourceRoot} · ${checkout.pin ? 'origin’s current main, recorded as the restore point' : 'the recorded restore point'} · built beside the destination, so it never overwrites a path`,
        }),
    ...(image.replace === null
      ? {}
      : {
          'delete-image': `${image.replace.fingerprint} · destructive · aliases removed with it: ${image.replace.aliases.join(', ') || 'none'}`,
        }),
    'import-image': 'uploaded without an alias, then checked as a container image for the target architecture',
    'create-alias': `${imageAlias} points at the selected image`,
    'create-network': `${layout.network.name} · ${layout.network.ipv4Subnet} · managed bridge`,
    'create-volume': `${layout.postgres.volumeName} · ${layout.postgres.config.size} · in pool ${layout.pool.name}`,
    'create-instance': `${name} · ${architecture.incus} container · created stopped${published}`,
    'update-instance': `${delivered} in one guarded complete instance update${published}`,
  }
}

function screenOf({ plan, held, inputs, source, ingress }: PlanPreview): ApprovalScreen {
  const details = detailsOf(plan, inputs, ingress)
  const fenced = (actions: readonly InstallAction[]): ApprovalStep[] => stepsOf(actions, INSTALL_STEPS, details)
  const actions = actionsOf(plan)
  const steps: ApprovalStep[] = [
    ...fenced(actions.filter(action => BEFORE_PIN.includes(action))),
    ...(plan.pin ? [{ label: 'Record the image pin in the installation record' }] : []),
    ...actions
      .filter(action => !BEFORE_PIN.includes(action))
      .flatMap((action): ApprovalStep[] =>
        action === 'update-instance' && plan.credentials !== 'reuse'
          ? [{ label: 'Write the local credentials', detail: CREDENTIALS[plan.credentials] }, ...fenced([action])]
          : fenced([action]),
      ),
  ]
  const covers = `Image ${plan.fingerprint} · ${source.kind === 'split' ? 'staged split artifacts' : 'existing local image; never pulled or replaced'}.`
  if (held !== null) {
    return {
      title: 'Proposed image import (first of two approvals)',
      steps,
      covers,
      stays: `The previous image ${held.fingerprint} (aliases: ${held.aliases.join(', ') || 'none'}) is not deleted by this approval. It is shown again for its own approval once the imported image passes its check.`,
      lasting: `${AUTHORITY} ${IMPORT_NOTE}`,
      notEstablished: TRUSTED,
    }
  }
  const publishes = inputs.publish !== null && (plan.instance || plan.publish)
  const delivers = plan.deliver && plan.ingress !== null
  return {
    title: 'Proposed installation changes',
    steps,
    covers,
    stays: 'This approval never starts the orchestrator, and persistent PostgreSQL data is kept. Startup asks for its own approval afterwards.',
    lasting: `${AUTHORITY} The instance mounts ${inputs.sourceRoot} writable, so it can modify the host checkout.${plan.image.import ? ` ${IMPORT_NOTE}` : ''}${publishes ? ` ${PUBLISH_NOTE}` : ''}${delivers ? ` ${INGRESS_NOTE}` : ''}`,
    notEstablished: delivers ? `${TRUSTED} ${DELIVERY_NOT_ESTABLISHED}` : TRUSTED,
  }
}

/**
 * Renders what an approved gate would change. Nothing described here has been
 * applied until the approval that follows it. An installation that already
 * matches has nothing to display.
 */
export function reportPlan(reporter: Reporter, preview: PlanPreview): void {
  if (isEmpty(preview.plan)) {
    return
  }
  reportApproval(reporter, screenOf(preview))
}
