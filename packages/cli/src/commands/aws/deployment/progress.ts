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
  return task.kind === 'key' ? 'Admin SSH key' : `Step ${task.position}/${task.total}`
}

function subject(task: ProgressTask): string {
  if (task.kind === 'key') {
    return 'Generate the local administrative SSH key'
  }
  const label = LABELS[task.action]
  return task.slot > 0 ? `${label} #${task.slot + 1}` : label
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
        reporter.row(
          'verified',
          title(task),
          `${subject(task)} · ${task.kind === 'key' ? 'key pair validated and binding recorded' : 'observation agrees with the record'}`,
        )
        return
    }
  }
}
