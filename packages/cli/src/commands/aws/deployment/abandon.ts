import { progressSink } from './progress'
import { authenticateDeployer, openTarget } from './shared'
import { requireAwsHost } from '../../../aws/host'
import { withConfirmedOperation } from '../../../aws/operation'
import { abandoned } from '../../../aws/deployment/handoff/stage'
import { dataVolumeId } from '../../../aws/deployment/topology'
import { observationSummary, reportDeployment } from './report'
import { deploymentName } from '../../../aws/deployment/volume/alias'
import { expectation, matches } from '../../../aws/deployment/observe/expect'
import { abandon as writeAbandonment } from '../../../aws/deployment/handoff/settle'
import { abandonable, deploymentFacts } from '../../../aws/deployment/observe/facts'
import { Prompts, withCancellation } from '../../../terminal/prompts'
import { reportApproval } from '../../../terminal/approval'
import { InstallerError, type DiagnosticFact } from '../../../diagnostic/error'
import * as deployments from '../../../aws/deployment/records'
import type { AwsDeploymentOptions } from '../../../input'
import type { Reporter } from '../../../terminal/reporter'
import type { Deployer } from '../../../aws/deployment/deployer'
import type { Dir } from '../../../state/files'
import type { Deployment, Observation } from '../../../aws/deployment/types'

function refusal(record: Deployment, reason: string, observation?: Observation): InstallerError {
  const facts: DiagnosticFact[] = [...deploymentFacts(record), ['Reason', reason]]
  if (observation) {
    facts.push(['Observed resources', observationSummary(observation)])
  }
  return new InstallerError({
    code: 'AWS_DEPLOYMENT_ABANDON_REFUSED',
    facts,
    retry: `qiln aws deployment inspect --id ${record.id}`,
  })
}

function reportAbandonment(reporter: Reporter, record: Deployment, observation: Observation): void {
  reporter.section('Reservation')
  reporter.facts([
    ['Deployment', record.id],
    ['Name', deploymentName(record.alias)],
    ['Previous deployment', record.previous ?? 'none'],
    ['Data volume', dataVolumeId(record) ?? 'no identity retained'],
  ])
  reportApproval(
    reporter,
    {
      title: 'Proposed abandonment',
      steps: [{ label: 'Release the reservation of the retained data volume' }],
      covers: "One local write that records this deployment's release of its reservation. Nothing is attached, detached, deleted, or modified in AWS.",
      stays:
        'This deployment keeps answering for the volume, which is retained, billable, and not removed by Qiln until it is deleted outside Qiln.',
      lasting:
        'Abandonment is not undone, and no further provider step may follow for this deployment. Afterwards the alias can be taken over and the volume reused through this record.',
    },
    { label: 'Fresh observation', detail: `${observationSummary(observation)} · agrees with the record` },
  )
}

/**
 * Takes a fresh observation, which must still agree with the record, shows the
 * release, and writes it only after a default-no approval. Returns false when
 * the operator declines, and then nothing was released.
 */
export async function releaseReservation(
  root: Dir,
  deployer: Deployer,
  prompts: Prompts,
  reporter: Reporter,
  signal: AbortSignal,
): Promise<boolean> {
  const observation = await deployer.observe(signal)
  const record = deployer.record
  if (!matches(expectation(record), observation)) {
    throw refusal(record, 'The fresh observation does not agree with the record, so nothing was released.', observation)
  }
  reportAbandonment(reporter, record, observation)
  if (!(await prompts.consent('Abandon the volume reservation'))) {
    return false
  }
  await writeAbandonment(root, record, observation)
  reportDeployment(reporter, await deployments.select(root, { kind: 'id', value: record.id }))
  return true
}

/**
 * Releases the reservation of a retained data volume by a replacement whose
 * attach never returned. It needs the replacement to be settled with nothing
 * left to remove, and a fresh observation that still agrees with the record,
 * which shows the volume available and unattached. Re-running after success
 * changes nothing and asks nothing.
 */
export async function abandon(options: AwsDeploymentOptions, reporter: Reporter): Promise<void> {
  requireAwsHost()
  const { selector } = options
  const message = await withCancellation(async signal => {
    const prompts = new Prompts(signal, `qiln aws deployment abandon --${selector.kind} ${selector.value}`, reporter)
    return await withConfirmedOperation(false, async ({ root, connections: store }) => {
      const target = await openTarget(root, store, selector)
      if (abandoned(target.record)) {
        reportDeployment(reporter, target.record)
        return 'Nothing to do: the volume is already released by abandonment.'
      }
      if (!abandonable(target.record)) {
        throw refusal(
          target.record,
          'Abandonment needs a reuse replacement whose volume attach never returned, with confirmed child termination, no unresolved step, and no created resource left to remove.',
        )
      }
      const deployer = await authenticateDeployer(root, target, signal, progressSink(reporter))
      if (!(await releaseReservation(root, deployer, prompts, reporter, signal))) {
        throw new InstallerError({
          code: 'COMMAND_CANCELLED',
        })
      }
      return 'Reservation abandoned. The retained data volume is not removed by Qiln and keeps incurring charges until it is deleted outside Qiln; the alias can now be taken over.'
    })
  })
  reporter.summary(message)
}
