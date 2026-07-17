import type { CapsuleHostDbContract, CapsuleOperationRequestHash } from '@qiln/core/server'
import type { CapsuleOperationReader, CapsuleOperationTransitionOutput } from '../../shared'
import { DestroyCapsuleAcceptancePersistence } from './acceptance'
import { DestroyCapsuleClassificationPersistence } from './classification'
import { completeDestroyCapsule } from './completion'
import { DestroyCapsuleExecutionPersistence } from './execution'
import type {
  DestroyCapsuleAbandonedClassificationResult,
  DestroyCapsuleExecutionInput,
  DestroyCapsuleRepositoryResult,
  DestroyCapsuleTerminalResult,
  SubmitDestroyCapsuleInput,
} from '../types'

/**
 * Destroy persistence facade consumed by submission, execution, and
 * abandonment capabilities.
 *
 * This is an intentional operation boundary rather than a compatibility
 * wrapper. Cohesive persistence modules own their transactions and policy
 * orchestration; the facade itself opens no transactions.
 */
export class DestroyCapsuleOperationRepository {
  private readonly acceptance: DestroyCapsuleAcceptancePersistence
  private readonly execution: DestroyCapsuleExecutionPersistence
  private readonly classification: DestroyCapsuleClassificationPersistence

  constructor(
    private readonly db: CapsuleHostDbContract,
    reader: CapsuleOperationReader,
  ) {
    this.acceptance = new DestroyCapsuleAcceptancePersistence(db, reader)
    this.execution = new DestroyCapsuleExecutionPersistence(db, reader)
    this.classification = new DestroyCapsuleClassificationPersistence(db, reader)
  }

  public async acceptOrReplay(
    input: SubmitDestroyCapsuleInput & {
      requestHash: CapsuleOperationRequestHash
    },
  ): Promise<DestroyCapsuleRepositoryResult> {
    return await this.acceptance.acceptOrReplay(input)
  }

  public async loadAcceptedExecutionInput(operationId: string): Promise<DestroyCapsuleExecutionInput> {
    return await this.execution.loadAcceptedExecutionInput(operationId)
  }

  public async claimAccepted(operationId: string): Promise<CapsuleOperationTransitionOutput> {
    return await this.execution.claimAccepted(operationId)
  }

  public async commitProviderIntentFence(operationId: string): Promise<void> {
    await this.execution.commitProviderIntentFence(operationId)
  }

  public async complete(operationId: string): Promise<DestroyCapsuleTerminalResult> {
    return await completeDestroyCapsule(this.db, operationId)
  }

  public async classifyExecutionFailure(
    operationId: string,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<DestroyCapsuleTerminalResult | null> {
    return await this.classification.classifyExecutionFailure(operationId, error, context)
  }

  public async classifyAbandoned(operationId: string): Promise<DestroyCapsuleAbandonedClassificationResult> {
    return await this.classification.classifyAbandoned(operationId)
  }
}
