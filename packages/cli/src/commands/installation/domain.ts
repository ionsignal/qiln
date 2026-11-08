import { actionsOf, type Acquisition, type Domain, type DomainProgress, type DomainStep } from '../../installation/domain/acquire'
import { reportApproval, stepsOf } from '../../terminal/approval'
import * as records from '../../installation/domain/records'
import type { DiagnosticFact } from '../../diagnostic/error'
import type { DomainAccess } from '../../installation/target/types'
import type { Dir } from '../../state/files'
import type { LiveRow, Reporter } from '../../terminal/reporter'
import type { StepText } from '../aws/deployment/prepare/steps'

/**
 * `short` names the progress row and must fit the row label column (26
 * characters). `label` is the sentence that an approval screen lists.
 */
const DOMAIN_STEPS: Record<DomainStep, StepText> = {
  register: {
    short: 'Register domain',
    label: 'Register the installation name and host address with the registration service',
  },
  issue: {
    short: 'Issue certificate',
    label: 'Request the apex and wildcard certificate for the retained TLS key',
  },
}

const RESULTS: Record<DomainStep, string> = {
  register: 'allocation recorded locally',
  issue: 'chain checked against the retained key and names, then recorded locally',
}

export interface AcquisitionPreview {
  plan: Acquisition
  name: string
  access: DomainAccess
}

/**
 * The wording of the default-no approval that goes with the displayed plan.
 */
export function domainApproval(plan: Acquisition): string {
  if (plan.register && plan.issue) {
    return 'Register the installation domain and request its certificate'
  }
  return plan.register ? 'Register the installation domain' : 'Request a new certificate for the installation domain'
}

/**
 * Renders what the approval that follows would do. Nothing described here has
 * been applied until that approval.
 */
export function reportAcquisition(reporter: Reporter, { plan, name, access }: AcquisitionPreview): void {
  const { service, subject } = access
  reportApproval(reporter, {
    title: 'Proposed domain acquisition',
    steps: stepsOf(actionsOf(plan), DOMAIN_STEPS, {
      register: `${service} allocates the stable name for installation ${name}, or confirms the existing one, and points it at ${subject.address}`,
      issue: `request one certificate for the allocated name and its wildcard from ${service}; a P-256 TLS key is generated and retained on this machine first if none exists, and only the public request leaves it`,
    }),
    covers: `Operator ${subject.principal} · installation ${name} · host address ${subject.address} · service ${service}.`,
    stays: 'The orchestrator is not started or changed, no cloud firewall port is opened, and no Incus resource is touched.',
    lasting:
      'The allocation and its DNS records outlive this run, and a label is never recycled. Caps apply, and the service counts attempts of every status. Qiln sends the service a signed AWS identity proof that includes the session token, once, and never writes it. A later failure does not roll back DNS records or a certificate.',
    notEstablished:
      'Public reachability, client trust beyond Qiln’s local chain checks, and delivery of the name and certificate to the orchestrator, which this run does not do. After a host replacement the name keeps its previous address until a configure run registers the new one.',
  })
}

/**
 * `working` starts a live row and `verified` finishes it, so a row is only
 * permanent once the reply was judged and persisted. A failure leaves the live
 * row to the diagnostic, which clears it.
 */
export function domainProgress(reporter: Reporter): (event: DomainProgress) => void {
  let live: LiveRow | null = null
  return ({ phase, step }) => {
    if (phase === 'working') {
      live = reporter.live(DOMAIN_STEPS[step].short, DOMAIN_STEPS[step].label)
      return
    }
    live?.finish('verified', RESULTS[step])
    live = null
  }
}

export function reportDomain(reporter: Reporter, { record, chain }: Domain): void {
  const apex = records.baseOf(record)
  reporter.row(
    'verified',
    'Domain',
    `${apex} and *.${apex} · ${record.address} · certificate valid until ${chain.notAfter.toISOString()} · checked locally against the retained key and names`,
  )
}

/**
 * Offline facts from retained evidence only: the allocation and certificate,
 * and an attempt whose outcome was never recorded. Nothing is contacted.
 */
export async function domainFacts(directory: Dir, retry: string): Promise<DiagnosticFact[]> {
  const evidence = await records.read(directory, retry)
  const attempt = await records.readAttempt(directory, retry)
  const facts: DiagnosticFact[] = []
  if (evidence === null) {
    facts.push(['Domain', 'none acquired'])
  } else {
    const { record, chain } = evidence
    const certificate =
      chain === null ? 'no certificate retained' : `certificate valid until ${chain.notAfter.toISOString()}`
    facts.push([
      'Domain',
      `${records.baseOf(record)} · address ${record.address} · ${certificate} · recorded evidence, not a fresh check of DNS or the service`,
    ])
  }
  if (attempt !== null) {
    facts.push([
      'Domain attempt',
      `A ${attempt.kind} request was started at ${attempt.at} and its outcome was not recorded. Nothing is blocked: run configure again.`,
    ])
  }
  return facts
}
