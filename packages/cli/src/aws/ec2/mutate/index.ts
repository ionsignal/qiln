import type { Deployment, Step } from '../../deployment/types'
import type { Ec2 } from '../client'
import type { KeyReader } from '../key'
import { isHostAction, mutateHost } from './host'
import { mutateNetwork } from './network'

export function mutate(ec2: Ec2, record: Deployment, step: Step, readKey: KeyReader): Promise<string | null> {
  return isHostAction(step.action) ? mutateHost(ec2, record, step, readKey) : mutateNetwork(ec2, record, step)
}
