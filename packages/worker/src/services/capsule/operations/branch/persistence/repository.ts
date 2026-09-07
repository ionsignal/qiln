import type { CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { PreviewGate } from '../../../routing/preview/gate'
import type { CapsuleOperationReader } from '../../shared'
import type {
  AcceptBranchInput,
  BranchAcceptance,
  BranchExecutionInput,
  BranchFailureInput,
  BranchOperationType,
  BranchState,
  BranchTerminalResult,
} from '../types'
import { BranchAcceptancePersistence } from './acceptance'
import { BranchClassificationPersistence } from './classification'
import { BranchExecutionPersistence } from './execution'
import { BranchLocks } from './locks'

export type BranchRepositoryOptions<
  TOperation extends BranchOperationType,
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> = {
  type: TOperation
  persistence: CapsulePersistence<TDatabase, TTables>
  operations: CapsuleOperationReader<TDatabase, TTables>
} & (
  | {
      type: 'branch_start'
      previews?: never
    }
  | {
      type: 'branch_stop'
      previews: PreviewGate<TDatabase, TTables>
    }
)

/**
 * Discriminator-bound persistence API for one branch runtime operation.
 *
 * Construction shares one lock boundary across the focused capabilities and
 * performs no SQL. Transaction and transition policy remain in those
 * capabilities rather than being repeated by this facade.
 */
export class BranchRepository<
  TOperation extends BranchOperationType,
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  public readonly type: TOperation

  private readonly acceptance: BranchAcceptancePersistence<TOperation, TDatabase, TTables>
  private readonly execution: BranchExecutionPersistence<TOperation, TDatabase, TTables>
  private readonly classification: BranchClassificationPersistence<TOperation, TDatabase, TTables>

  constructor(options: BranchRepositoryOptions<TOperation, TDatabase, TTables>) {
    this.type = options.type
    const locks = new BranchLocks(options.persistence, options.type)
    this.acceptance = new BranchAcceptancePersistence(options.persistence, locks, options.operations)
    this.execution = new BranchExecutionPersistence(options.persistence, locks, options.previews)
    this.classification = new BranchClassificationPersistence(options.persistence, locks)
  }

  public accept(input: AcceptBranchInput): Promise<BranchAcceptance<TOperation>> {
    return this.acceptance.accept(input)
  }

  public load(operationId: string): Promise<BranchExecutionInput> {
    return this.execution.load(operationId)
  }

  public claim(operationId: string) {
    return this.execution.claim(operationId)
  }

  public intent(operationId: string): Promise<void> {
    return this.execution.intent(operationId)
  }

  public online(
    this: BranchRepository<'branch_start', TDatabase, TTables>,
    operationId: string,
    runtimeIp: string | null,
  ): Promise<BranchState> {
    return this.execution.online(operationId, runtimeIp)
  }

  public complete(operationId: string): Promise<BranchTerminalResult> {
    return this.execution.complete(operationId)
  }

  public fail(input: BranchFailureInput): Promise<BranchTerminalResult> {
    return this.classification.fail(input)
  }

  public classifyAbandoned(operationId: string): Promise<BranchTerminalResult | null> {
    return this.classification.classifyAbandoned(operationId)
  }
}
