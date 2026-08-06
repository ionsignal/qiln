import {
  CapsuleActorType,
  CapsuleOperationType,
  CapsuleSnapshotAgentArtifactContentPolicy,
  type CapsuleSnapshotCaptureReceipt,
} from '@qiln/core/server'
import { IncusError } from '../../../../errors'
import { createOperationRequestHash } from '../shared'
import type { OperationSupervisor } from '../../../../coordination'
import type {
  CapsuleBranchEventPublisher,
  CapsuleLifecycleEventPublisher,
  CapsuleOperationEventPublisher,
} from '../../events'
import type { CaptureExecutor } from './executor'
import type { CaptureRepository } from './persistence'
import type { SubmitCaptureCapsuleInput } from './types'

interface CaptureRequestIdentity {
  operationType: typeof CapsuleOperationType.SNAPSHOT_CAPTURE
  actor: SubmitCaptureCapsuleInput['actor']
  capsuleId: string
  sourceBranchId: string
  agentArtifactContentPolicy: SubmitCaptureCapsuleInput['agentArtifactContentPolicy']
}

export interface CaptureSubmissionOptions {
  enabled: boolean
}

/**
 * Accepts or replays experimental Snapshot Capture operations.
 *
 * The feature gate is Worker-owned. Browser input cannot weaken the requested
 * evidence mode or bypass the gate.
 */
export class CaptureSubmission {
  constructor(
    private readonly repository: CaptureRepository,
    private readonly executor: CaptureExecutor,
    private readonly supervisor: OperationSupervisor,
    private readonly operationEvents: CapsuleOperationEventPublisher,
    private readonly lifecycleEvents: CapsuleLifecycleEventPublisher,
    private readonly branchEvents: CapsuleBranchEventPublisher,
    private readonly options: CaptureSubmissionOptions,
  ) {}

  public async submit(input: SubmitCaptureCapsuleInput): Promise<CapsuleSnapshotCaptureReceipt> {
    if (!this.options.enabled) {
      throw new IncusError('Experimental Snapshot Capture is disabled for this Worker.', 'FORBIDDEN', {
        feature: 'experimental_snapshot_capture',
      })
    }
    this.assertAgentArtifactContentPolicy(input)
    const requestHash = createOperationRequestHash(
      {
        operationType: CapsuleOperationType.SNAPSHOT_CAPTURE,
        actor: input.actor,
        capsuleId: input.capsuleId,
        sourceBranchId: input.sourceBranchId,
        agentArtifactContentPolicy: input.agentArtifactContentPolicy,
      } satisfies CaptureRequestIdentity,
      'experimental Snapshot Capture request',
    )
    const acceptance = await this.repository.accept({
      ...input,
      requestHash,
    })
    if (!acceptance.newlyAccepted) {
      return acceptance.receipt
    }
    this.operationEvents.publishChanged(acceptance.operation)
    this.lifecycleEvents.publishChanged(acceptance.operation.ownerId, acceptance.capsule)
    this.branchEvents.publishStateChanged(
      acceptance.operation.ownerId,
      acceptance.branch.capsuleId,
      acceptance.branch.name,
      acceptance.branch.status,
    )
    const operationId = acceptance.receipt.operationId
    const executor = this.executor
    this.supervisor.schedule(operationId, () => executor.execute(operationId))
    return acceptance.receipt
  }

  private assertAgentArtifactContentPolicy(input: SubmitCaptureCapsuleInput): void {
    if (
      input.agentArtifactContentPolicy !== CapsuleSnapshotAgentArtifactContentPolicy.DENY &&
      input.agentArtifactContentPolicy !== CapsuleSnapshotAgentArtifactContentPolicy.OWNER_AUTHORIZED_UNREVIEWED
    ) {
      throw new IncusError('Snapshot Capture received an unsupported agent artifact-read mode.', 'VALIDATION_ERROR', {
        agentArtifactContentPolicy: input.agentArtifactContentPolicy,
      })
    }
    if (input.agentArtifactContentPolicy === CapsuleSnapshotAgentArtifactContentPolicy.DENY) {
      return
    }
    if (input.actor.type === CapsuleActorType.USER && input.actor.id === input.ownerId) {
      return
    }
    throw new IncusError('Unchecked agent artifact reads may be elected only by the capsule owner user.', 'FORBIDDEN', {
      capsuleId: input.capsuleId,
      actorType: input.actor.type,
    })
  }
}
