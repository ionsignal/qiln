import { isHostAction, mutateHost } from './host'
import { mutateNetwork } from './network'
import type { Deployment, Step } from '../../deployment/types'
import type { PublicKeyReader } from '../../ssh/store'
import type { Ec2 } from '../client'

export function mutate(ec2: Ec2, record: Deployment, step: Step, readKey: PublicKeyReader): Promise<string | null> {
  return isHostAction(step.action) ? mutateHost(ec2, record, step, readKey) : mutateNetwork(ec2, record, step)
}