import { requireAwsHost } from '../../../aws/host'
import { withConfirmedOperation } from '../../../aws/operation'
import { InstallerError } from '../../../diagnostic/error'
import { invalidDeployment } from '../../../aws/deployment/ledger/invalid'
import { settle } from '../../../aws/deployment/handoff/settle'
import { holdsVolume, stageOf } from '../../../aws/deployment/handoff/stage'
import { Prompts, withCancellation } from '../../../terminal/prompts'
import { reportApproval } from '../../../terminal/approval'
import { reportHandoff } from './report'
import * as deployments from '../../../aws/deployment/records'
import type { AwsDeploymentOptions } from '../../../input'
import type { Reporter } from '../../../terminal/reporter'

/**
 * Writes the missing local hand-off records of a replacement that reuses a
 * retained data volume: the reservation on the previous deployment, and the
 * completion once the replacement holds the volume. Everything is derived from
 * retained evidence, so there is no authentication and no AWS call. Re-running
 * after success, or before there is anything to settle, changes nothing and
 * asks nothing.
 */
export async function handoff(options: AwsDeploymentOptions, reporter: Reporter): Promise<void> {
  requireAwsHost()
  const { selector } = options
  const message = await withCancellation(async signal => {
    const prompts = new Prompts(signal, `qiln aws deployment handoff --${selector.kind} ${selector.value}`, reporter)
    return await withConfirmedOperation(false, async ({ root }) => {
      const replacement = await deployments.select(root, selector)
      const { volume } = replacement.approval.host
      if (volume.kind !== 'reuse') {
        return 'Nothing to do: this deployment did not reuse a retained data volume.'
      }
      const previous = (await deployments.read(root, volume.from)) ?? invalidDeployment()
      const { successor } = previous
      if (successor !== null && successor.to !== replacement.id) {
        throw new InstallerError({
          code: 'AWS_DEPLOYMENT_HANDOFF_PENDING',
          facts: [
            ['Previous deployment', previous.id],
            ['Replacement deployment', replacement.id],
            ['Observed', `The previous deployment reserved the volume for deployment ${successor.to}, not for this one.`],
          ],
          retry: `qiln aws deployment status --id ${previous.id}`,
        })
      }
      const stage = stageOf(previous, replacement)
      reportHandoff(reporter, previous, replacement, stage)
      const writes = [
        ...(successor === null ? ['the reservation of the volume by the replacement'] : []),
        ...(holdsVolume(replacement) && successor?.completedAt == null ? ['the completed hand-off'] : []),
      ]
      if (writes.length === 0) {
        return stage === 'completed'
          ? 'Nothing to do: the reservation and completion are already recorded.'
          : 'Nothing to do yet: the replacement does not hold the volume, so there is no completion to record.'
      }
      reportApproval(reporter, {
        title: 'Proposed hand-off evidence',
        steps: writes.map(write => ({ label: `Record ${write}` })),
        covers: `Local evidence for volume ${volume.volumeId}, derived from matching retained records.`,
        stays: 'No AWS call is made, and nothing is attached, detached, replayed, or deleted.',
        lasting: 'The volume stays retained and billable until it is deleted outside Qiln.',
      })
      await prompts.approve('Record the hand-off evidence')
      await settle(root, replacement)
      return 'Hand-off evidence recorded from local evidence. No AWS call was made and no resource was changed.'
    })
  })
  reporter.summary(message)
}
