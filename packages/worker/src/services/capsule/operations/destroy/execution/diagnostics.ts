import type { DestroyExecutionState } from './state'
import type { DestroyExecution } from '../types'

/**
 * Durable classification reloads the actual operation fence. These fields
 * explain what the executor observed without becoming mutation authority.
 */
export function destroyDiagnostics(
  operationId: string,
  state: DestroyExecutionState,
  execution: DestroyExecution | null,
): Record<string, unknown> {
  return {
    operationId,
    phase: state.phase,
    stepKey: state.step,
    providerIntentConfirmed: state.providerIntentConfirmed,
    completionConfirmed: state.completionConfirmed,
    ...(execution === null
      ? {}
      : {
          capsuleId: execution.capsuleId,
          force: execution.force,
          branchCount: execution.plan.branchCount,
          instanceCount: execution.plan.instances.length,
          volumeCount: execution.plan.volumes.length,
          provisioningFileCount: execution.plan.files.length,
          providerRequired: execution.plan.providerRequired,
          withdrawPreviews: execution.withdrawPreviews,
        }),
  }
}
