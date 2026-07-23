import type { CapsuleHostDbContract, CapsuleOperationRequestHash } from '@qiln/core/server'
import type { CapsuleOperationReader } from '../../shared'
import type { CapturePlanner } from '../plan'
import { CaptureAcceptancePersistence } from './accept'
import { CaptureCommitPersistence } from './commit'
import { CaptureCompensationPersistence } from './compensation'
import { CaptureExecutionPersistence } from './execution'
import { CaptureFailurePersistence } from './failure'
import { CaptureInputPersistence } from './input'
import { CaptureResourcePersistence } from './resource'
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
export class CaptureRepository {
  private readonly acceptance: CaptureAcceptancePersistence
  private readonly input: CaptureInputPersistence
  private readonly execution: CaptureExecutionPersistence
  private readonly commitPersistence: CaptureCommitPersistence
  private readonly failure: CaptureFailurePersistence
  private readonly compensation: CaptureCompensationPersistence

  public readonly resources: CaptureResourcePersistence

  constructor(db: CapsuleHostDbContract, reader: CapsuleOperationReader, planner: CapturePlanner) {
    this.acceptance = new CaptureAcceptancePersistence(db, reader, planner)
    this.input = new CaptureInputPersistence(db, reader, planner)
    this.execution = new CaptureExecutionPersistence(db)
    this.resources = new CaptureResourcePersistence(db)
    this.commitPersistence = new CaptureCommitPersistence(db)
    this.failure = new CaptureFailurePersistence(db, reader, planner)
    this.compensation = new CaptureCompensationPersistence(db)
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
