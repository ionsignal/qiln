import type {
  CapsuleActorReference,
  CapsuleBranchResourceInventoryDigest,
  CapsuleOperationRequestHash,
  CapsuleTables,
} from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { CapsuleOperationTransitionOutput } from '../../shared'
import type {
  AcceptCreateCapsuleOperationInput,
  CreateCapsuleExecutionInput,
  CreateCapsuleFailureInput,
  CreateCapsuleRepositoryResult,
  CreateCapsuleTerminalResult,
} from '../types'
import type { CreateCapsuleAcceptance } from './acceptance'
import type { CreateCapsuleClassification } from './classification'
import type { CreateCapsuleCompletion } from './completion'
import type { CreateCapsuleExecution } from './execution'

export interface CreateCapsuleRepositoryCapabilities<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  acceptance: CreateCapsuleAcceptance<TDatabase, TTables>
  execution: CreateCapsuleExecution<TDatabase, TTables>
  completion: CreateCapsuleCompletion<TDatabase, TTables>
  classification: CreateCapsuleClassification<TDatabase, TTables>
}

/**
 * Convenient create persistence boundary for submission, execution, and
 * abandonment.
 *
 * Transactions, validation, and failure policy belong to the injected
 * capabilities. This facade performs direct delegation only.
 */
export class CreateCapsuleOperationRepository<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(private readonly capabilities: CreateCapsuleRepositoryCapabilities<TDatabase, TTables>) {}

  public findReplay(
    ownerId: string,
    actor: CapsuleActorReference,
    idempotencyKey: string,
    requestHash: CapsuleOperationRequestHash,
  ): Promise<CreateCapsuleRepositoryResult | null> {
    return this.capabilities.acceptance.findReplay(ownerId, actor, idempotencyKey, requestHash)
  }

  public accept(input: AcceptCreateCapsuleOperationInput): Promise<CreateCapsuleRepositoryResult> {
    return this.capabilities.acceptance.accept(input)
  }

  public loadExecution(operationId: string): Promise<CreateCapsuleExecutionInput> {
    return this.capabilities.execution.loadExecution(operationId)
  }

  public claim(operationId: string): Promise<CapsuleOperationTransitionOutput> {
    return this.capabilities.execution.claim(operationId)
  }

  public recordInventory(operationId: string, digest: CapsuleBranchResourceInventoryDigest): Promise<void> {
    return this.capabilities.execution.recordInventory(operationId, digest)
  }

  public commitProviderIntent(operationId: string): Promise<void> {
    return this.capabilities.execution.commitProviderIntent(operationId)
  }

  public complete(operationId: string): Promise<CreateCapsuleTerminalResult> {
    return this.capabilities.completion.complete(operationId)
  }

  public fail(input: CreateCapsuleFailureInput): Promise<CreateCapsuleTerminalResult> {
    return this.capabilities.classification.fail(input)
  }

  public classifyAbandoned(operationId: string): Promise<CreateCapsuleTerminalResult | null> {
    return this.capabilities.classification.classifyAbandoned(operationId)
  }
}
