import type { CapsuleActorReference, CapsuleOperationRequestHash, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { CapsuleOperationTransitionOutput } from '../../shared'
import type {
  CapsuleCreateAcceptanceInput,
  CapsuleCreateExecutionInput,
  CapsuleCreateFailureInput,
  CapsuleCreateAcceptanceResult,
  CapsuleCreateTerminalResult,
} from '../types'
import type { CapsuleCreateAcceptance } from './acceptance'
import type { CapsuleCreateClassification } from './classification'
import type { CapsuleCreateCompletion } from './completion'
import type { CapsuleCreateExecution } from './execution'

export interface CapsuleCreateRepositoryCapabilities<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  acceptance: CapsuleCreateAcceptance<TDatabase, TTables>
  execution: CapsuleCreateExecution<TDatabase, TTables>
  completion: CapsuleCreateCompletion<TDatabase, TTables>
  classification: CapsuleCreateClassification<TDatabase, TTables>
}

/**
 * Convenient create persistence boundary for submission, execution, and
 * abandonment.
 *
 * Transactions, validation, and failure policy belong to the injected
 * capabilities. This facade performs direct delegation only.
 */
export class CapsuleCreateRepository<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(private readonly capabilities: CapsuleCreateRepositoryCapabilities<TDatabase, TTables>) {}

  public findReplay(
    ownerId: string,
    actor: CapsuleActorReference,
    idempotencyKey: string,
    requestHash: CapsuleOperationRequestHash,
  ): Promise<CapsuleCreateAcceptanceResult | null> {
    return this.capabilities.acceptance.findReplay(ownerId, actor, idempotencyKey, requestHash)
  }

  public accept(input: CapsuleCreateAcceptanceInput): Promise<CapsuleCreateAcceptanceResult> {
    return this.capabilities.acceptance.accept(input)
  }

  public loadExecution(operationId: string): Promise<CapsuleCreateExecutionInput> {
    return this.capabilities.execution.loadExecution(operationId)
  }

  public claim(operationId: string): Promise<CapsuleOperationTransitionOutput> {
    return this.capabilities.execution.claim(operationId)
  }

  public materialize(operationId: string): Promise<void> {
    return this.capabilities.execution.materialize(operationId)
  }

  public commitProviderIntent(operationId: string): Promise<void> {
    return this.capabilities.execution.commitProviderIntent(operationId)
  }

  public complete(operationId: string): Promise<CapsuleCreateTerminalResult> {
    return this.capabilities.completion.complete(operationId)
  }

  public fail(input: CapsuleCreateFailureInput): Promise<CapsuleCreateTerminalResult> {
    return this.capabilities.classification.fail(input)
  }

  public classifyAbandoned(operationId: string): Promise<CapsuleCreateTerminalResult | null> {
    return this.capabilities.classification.classifyAbandoned(operationId)
  }
}
