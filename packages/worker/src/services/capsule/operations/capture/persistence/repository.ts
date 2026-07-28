import type { CapsuleOperationRequestHash, CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { CapsuleOperationReader } from '../../shared'
import type { CapturePlanner } from '../plan'
import { CaptureAcceptancePersistence } from './accept'
import { CaptureCommitPersistence } from './commit'
import { CaptureCompensationPersistence } from './compensation'
import { CaptureExecutionPersistence } from './execution'
import { CaptureFailurePersistence } from './failure'
import { CaptureInputPersistence } from './input'
import { CaptureResourcePersistence } from './resource'
import { CaptureSourcePersistence } from './source'
import type {
  CaptureAbandonedClassificationResult,
  CaptureAcceptanceResult,
  CaptureCommitResult,
  CaptureExecutionInput,
  CaptureRunningResult,
  CaptureTerminalResult,
  CommitCaptureInput,
  SubmitCaptureCapsuleInput,
} from '../types'

/**
 * Snapshot Capture persistence facade.
 *
 * Cohesive persistence modules own their transaction boundaries. This facade
 * opens no transaction itself.
 */
export class CaptureRepository<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  private readonly acceptance: CaptureAcceptancePersistence<TDatabase, TTables>
  private readonly input: CaptureInputPersistence<TDatabase, TTables>
  private readonly execution: CaptureExecutionPersistence<TDatabase, TTables>
  private readonly commitPersistence: CaptureCommitPersistence<TDatabase, TTables>
  private readonly failure: CaptureFailurePersistence<TDatabase, TTables>
  private readonly compensation: CaptureCompensationPersistence<TDatabase, TTables>

  public readonly resources: CaptureResourcePersistence<TDatabase, TTables>

  constructor(
    persistence: CapsulePersistence<TDatabase, TTables>,
    reader: CapsuleOperationReader<TDatabase, TTables>,
    planner: CapturePlanner,
  ) {
    const sources = new CaptureSourcePersistence(persistence)
    this.acceptance = new CaptureAcceptancePersistence(persistence, reader, planner, sources)
    this.input = new CaptureInputPersistence(persistence, reader, planner, sources)
    this.execution = new CaptureExecutionPersistence(persistence)
    this.resources = new CaptureResourcePersistence(persistence)
    this.commitPersistence = new CaptureCommitPersistence(persistence)
    this.failure = new CaptureFailurePersistence(persistence, reader, planner, sources)
    this.compensation = new CaptureCompensationPersistence(persistence)
  }

  public async accept(
    input: SubmitCaptureCapsuleInput & {
      requestHash: CapsuleOperationRequestHash
    },
  ): Promise<CaptureAcceptanceResult> {
    return await this.acceptance.accept(input)
  }

  public async load(operationId: string): Promise<CaptureExecutionInput> {
    return await this.input.load(operationId)
  }

  public async claim(operationId: string): Promise<CaptureRunningResult> {
    return await this.execution.claim(operationId)
  }

  public async intent(operationId: string): Promise<void> {
    await this.execution.intent(operationId)
  }

  public async commit(input: CommitCaptureInput): Promise<CaptureCommitResult> {
    return await this.commitPersistence.commit(input)
  }

  /**
   * Applies pre-provider failure or fail-closed uncertainty classification.
   *
   * Post-provider ordinary failure is available only through `compensated()`,
   * which independently proves all provider resources reached deleted or
   * missing outcomes.
   */
  public async classify(
    operationId: string,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<CaptureTerminalResult | null> {
    return await this.failure.classify(operationId, error, context)
  }

  public async compensated(
    operationId: string,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<CaptureTerminalResult> {
    return await this.compensation.fail(operationId, error, context)
  }

  public async abandon(operationId: string): Promise<CaptureAbandonedClassificationResult> {
    return await this.failure.abandon(operationId)
  }
}
