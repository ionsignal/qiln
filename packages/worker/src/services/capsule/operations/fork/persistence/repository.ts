import type { CapsuleOperationRequestHash, CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { CapsuleOperationReader } from '../../shared'
import { ForkPlanner } from '../plan'
import type {
  ForkAcceptance,
  ForkExecution,
  ForkRunning,
  ForkTerminal,
  SubmitForkInput,
  ForkAbandonmentResult,
} from '../types'
import { ForkAcceptancePersistence } from './accept'
import { ForkCommitPersistence } from './commit'
import { ForkExecutionPersistence } from './execution'
import { ForkFailurePersistence } from './failure'
import { ForkInputPersistence } from './input'
import { ForkSourcePersistence } from './source'

/**
 * Fork persistence façade.
 *
 * Each focused persistence component owns its own transaction boundaries. This
 * façade performs no SQL directly.
 */
export class ForkRepository<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  private readonly acceptance: ForkAcceptancePersistence<TDatabase, TTables>
  private readonly input: ForkInputPersistence<TDatabase, TTables>
  private readonly execution: ForkExecutionPersistence<TDatabase, TTables>
  private readonly commitPersistence: ForkCommitPersistence<TDatabase, TTables>
  private readonly failure: ForkFailurePersistence<TDatabase, TTables>

  constructor(persistence: CapsulePersistence<TDatabase, TTables>, reader: CapsuleOperationReader<TDatabase, TTables>) {
    const planner = new ForkPlanner()
    const sources = new ForkSourcePersistence(persistence)
    this.acceptance = new ForkAcceptancePersistence(persistence, reader, planner, sources)
    this.input = new ForkInputPersistence(persistence, planner, sources)
    this.execution = new ForkExecutionPersistence(persistence)
    this.commitPersistence = new ForkCommitPersistence(persistence, planner, sources)
    this.failure = new ForkFailurePersistence(persistence, reader, planner, sources)
  }

  public async accept(
    input: SubmitForkInput & {
      requestHash: CapsuleOperationRequestHash
    },
  ): Promise<ForkAcceptance> {
    return await this.acceptance.accept(input)
  }

  public async load(operationId: string): Promise<ForkExecution> {
    return await this.input.load(operationId)
  }

  public async claim(operationId: string): Promise<ForkRunning> {
    return await this.execution.claim(operationId)
  }

  public async intent(operationId: string): Promise<void> {
    await this.execution.intent(operationId)
  }

  public async commit(operationId: string): Promise<ForkTerminal> {
    return await this.commitPersistence.commit(operationId)
  }

  public async compensated(
    operationId: string,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<ForkTerminal> {
    return await this.failure.compensated(operationId, error, context)
  }

  public async classify(
    operationId: string,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<ForkTerminal | null> {
    return await this.failure.classify(operationId, error, context)
  }

  public async abandon(operationId: string): Promise<ForkAbandonmentResult> {
    return await this.failure.abandon(operationId)
  }
}
