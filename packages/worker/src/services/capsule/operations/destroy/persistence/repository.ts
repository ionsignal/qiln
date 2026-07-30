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
import type { CapsuleOperationRequestHash, CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { CapsuleOperationReader, CapsuleOperationTransitionOutput } from '../../shared'
import type { PreviewGate } from '../../../routing/preview/gate'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

/**
 * Destroy persistence facade consumed by submission, execution, and abandonment
 * capabilities.
 *
 * This is an intentional operation boundary rather than a compatibility
 * wrapper. Cohesive persistence modules own their transactions and policy
 * orchestration; the facade itself opens no transactions.
 */
export class DestroyCapsuleOperationRepository<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  private readonly acceptance: DestroyCapsuleAcceptancePersistence<TDatabase, TTables>
  private readonly execution: DestroyCapsuleExecutionPersistence<TDatabase, TTables>
  private readonly classification: DestroyCapsuleClassificationPersistence<TDatabase, TTables>

  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    reader: CapsuleOperationReader<TDatabase, TTables>,
    previewGate: PreviewGate<TDatabase, TTables>,
  ) {
    this.acceptance = new DestroyCapsuleAcceptancePersistence(persistence, reader, previewGate)
    this.execution = new DestroyCapsuleExecutionPersistence(persistence, reader)
    this.classification = new DestroyCapsuleClassificationPersistence(persistence, reader)
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
    return await completeDestroyCapsule(this.persistence, operationId)
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
