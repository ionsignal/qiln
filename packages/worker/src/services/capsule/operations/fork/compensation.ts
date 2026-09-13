import type { IncusClient } from '../../../../incus/client'
import type { CapsuleBranchResourceStore } from '../../resource'
import type { ForkRepository } from './persistence'

export interface ForkCompensationFailure {
  resourceId: string
  resourceKey: string
  code: string
  message: string
  details?: Record<string, unknown>
}

export interface ForkCompensationResult {
  complete: boolean
  failures: readonly ForkCompensationFailure[]
}

export interface ForkCompensationDependencies {
  incus: IncusClient
  resources: CapsuleBranchResourceStore
  repository: ForkRepository
}

/**
 * Fork compensation remains unavailable while fork accounting is being
 * reworked to match the current create and destroy evidence model.
 */
export class ForkCompensation {
  constructor(_dependencies: ForkCompensationDependencies) {}

  public async run(operationId: string): Promise<ForkCompensationResult> {
    return {
      complete: false,
      failures: [
        {
          resourceId: operationId,
          resourceKey: 'fork',
          code: 'FORK_UNAVAILABLE',
          message: 'Capsule fork compensation is temporarily unavailable.',
        },
      ],
    }
  }
}
