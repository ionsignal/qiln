import { IncusError } from '../../../../errors'
import type { CapsuleForkReceipt } from '@qiln/core/server'
import type { OperationSupervisor } from '../../../../coordination'
import type {
  CapsuleBranchEventPublisher,
  CapsuleLifecycleEventPublisher,
  CapsuleOperationEventPublisher,
} from '../../events'
import type { ForkExecutor } from './executor'
import type { ForkRepository } from './persistence'
import type { SubmitForkInput } from './types'

/**
 * Fork submission remains unavailable while its resource accounting is being
 * reworked to match the current create and destroy evidence model.
 */
export class ForkSubmission {
  constructor(
    _repository: ForkRepository,
    _executor: ForkExecutor,
    _supervisor: OperationSupervisor,
    _operationEvents: CapsuleOperationEventPublisher,
    _lifecycleEvents: CapsuleLifecycleEventPublisher,
    _branchEvents: CapsuleBranchEventPublisher,
  ) {}

  public async submit(_input: SubmitForkInput): Promise<CapsuleForkReceipt> {
    throw new IncusError('Capsule forks are temporarily unavailable.', 'CONFLICT')
  }
}
