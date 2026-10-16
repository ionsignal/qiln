import type { Action } from '../../../aws/deployment/graph'
import type { ProgressSink, ProgressTask } from '../../../aws/deployment/progress'
import type { Reporter } from '../../../terminal/reporter'

const LABELS: Record<Action, string> = {
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

function title(task: ProgressTask): string {
  switch (task.kind) {
    case 'key':
      return 'Admin SSH key'
    case 'health':
      return 'AWS health'
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
    case 'step': {
      const label = LABELS[task.action]
      return task.slot > 0 ? `${label} #${task.slot + 1}` : label
    }
  }
}

function verifiedDetail(task: ProgressTask): string {
  switch (task.kind) {
    case 'key':
      return 'key pair validated and binding recorded'
    case 'health':
      return 'running with system, instance and attached-EBS checks ok; point-in-time AWS status only'
    case 'step':
      return 'observation agrees with the record'
  }
}

export function progressSink(reporter: Reporter): ProgressSink {
  return event => {
    const { task } = event
    switch (event.phase) {
      case 'working':
        reporter.row('working', title(task), subject(task))
        return
      case 'waiting':
        reporter.info(`Waiting on '${subject(task)}' · ${Math.round(event.elapsedMs / 1000)}s elapsed.`)
        return
      case 'verified':
        reporter.row('verified', title(task), `${subject(task)} · ${verifiedDetail(task)}`)
        return
    }
  }
}
