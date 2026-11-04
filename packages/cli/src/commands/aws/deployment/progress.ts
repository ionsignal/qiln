import { INCUS_STEPS, ZFS_STEPS } from './prepare/steps'
import type { Action } from '../../../aws/deployment/graph'
import type { ProgressSink, ProgressTask } from '../../../aws/deployment/observe/progress'
import type { LiveRow, Reporter } from '../../../terminal/reporter'

export const ACTION_LABELS: Record<Action, string> = {
  'create-vpc': 'Create VPC',
  'create-subnet': 'Create subnet',
  'create-gateway': 'Create internet gateway',
  'attach-gateway': 'Attach internet gateway',
  'create-route-table': 'Create route table',
  'create-route': 'Add internet route',
  'associate-subnet': 'Associate route table with subnet',
  'create-group': 'Create security group',
  'allow-ingress': 'Allow ingress rule',
  'import-key-pair': 'Import AWS key pair',
  'run-instances': 'Launch instance',
  'create-volume': 'Create data volume',
  'attach-volume': 'Attach data volume',
  'allocate-address': 'Allocate Elastic IP',
  'associate-address': 'Associate Elastic IP',
  'disassociate-address': 'Disassociate Elastic IP',
  'release-address': 'Release Elastic IP',
  'terminate-instance': 'Terminate instance',
  'delete-key-pair': 'Delete AWS key pair',
  'delete-group': 'Delete security group',
  'disassociate-subnet': 'Disassociate subnet',
  'delete-subnet': 'Delete subnet',
  'delete-route-table': 'Delete route table',
  'detach-gateway': 'Detach internet gateway',
  'delete-gateway': 'Delete internet gateway',
  'delete-vpc': 'Delete VPC',
}

/**
 * ZFS and Incus rows are named by their step, so the row label already says
 * what runs and a verified row only needs to say how it was confirmed.
 */
function isHostStep(task: ProgressTask): boolean {
  return task.kind === 'zfs' || task.kind === 'incus'
}

function title(task: ProgressTask): string {
  switch (task.kind) {
    case 'key':
      return 'Admin SSH key'
    case 'health':
      return 'AWS health'
    case 'hostkey':
      return 'SSH host key'
    case 'zfs':
      return ZFS_STEPS[task.action].short
    case 'incus':
      return INCUS_STEPS[task.action].short
    case 'step':
      return `Step ${task.position}/${task.total}`
  }
}

function subject(task: ProgressTask): string {
  switch (task.kind) {
    case 'key':
      return 'Generate the local administrative SSH key'
    case 'health':
      return 'Check AWS instance and attached-EBS status'
    case 'hostkey':
      return 'Read the server host key from AWS console output'
    case 'zfs':
      return ZFS_STEPS[task.action].label
    case 'incus':
      return INCUS_STEPS[task.action].label
    case 'step': {
      const label = ACTION_LABELS[task.action]
      const numbered = task.slot > 0 ? `${label} #${task.slot + 1}` : label
      const { attempt } = task
      return attempt === undefined
        ? numbered
        : `${numbered} in ${attempt.zone} (attempt ${attempt.number}/${attempt.total})`
    }
  }
}

function verifiedDetail(task: ProgressTask): string {
  switch (task.kind) {
    case 'key':
      return 'key pair validated and binding recorded'
    case 'health':
      return 'running with system, instance and attached-EBS checks ok; point-in-time AWS status only'
    case 'hostkey':
      return 'Ed25519 fingerprint retained as AWS-reported console evidence; not guest attestation'
    case 'zfs':
    case 'incus':
      return 'fresh inspection agrees'
    case 'step':
      return 'observation agrees with the record'
  }
}

/**
 * `working` starts a live row and `verified` finishes it, so a row is only
 * permanent once the observation and its persistence succeeded. A failure
 * leaves the live row to the diagnostic, which clears it.
 */
export function progressSink(reporter: Reporter): ProgressSink {
  let live: LiveRow | null = null
  return event => {
    const { task } = event
    switch (event.phase) {
      case 'working':
        live = reporter.live(title(task), subject(task))
        return
      case 'declined':
        live?.drop()
        live = null
        reporter.notice(
          `AWS has no capacity for '${subject(task)}'. The refusal is recorded and nothing was launched. The next approved zone is tried.`,
        )
        return
      case 'verified': {
        const detail = verifiedDetail(task)
        const text = isHostStep(task) ? detail : `${subject(task)} · ${detail}`
        if (live === null) {
          reporter.row('verified', title(task), text)
        } else {
          live.finish('verified', text)
        }
        live = null
        return
      }
    }
  }
}
