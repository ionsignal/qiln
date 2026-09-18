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

/**
 * Fork compensation remains unavailable while fork accounting is being reworked
 * to match the current create and destroy evidence model.
 */
export class ForkCompensation {
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
