import { and, asc, eq } from 'drizzle-orm'
import {
  CapsuleArchiveOperationOutputSchema,
  CapsuleBranchNameSchema,
  CapsuleCreateCommandName,
  CapsuleCreateOutputSchema,
  CapsuleDestroyOperationOutputSchema,
  CapsuleOperationCommandName,
  CapsuleOperationFailureSchema,
  CapsuleOperationStatus,
  CapsuleOperationSummarySchema,
  CapsuleUnarchiveOperationOutputSchema,
  DEFAULT_CAPSULE_BLUEPRINT_NAME,
  GlobalError,
  GlobalErrorCode,
  TargetType,
  capsuleOperationsTable,
  type CapsuleActorReference,
  type CapsuleArchiveOperationOutput,
  type CapsuleBlueprintDigest,
  type CapsuleBranchName,
  type CapsuleChannel,
  type CapsuleCreateOutput,
  type CapsuleDestroyOperationOutput,
  type CapsuleHostDbContract,
  type CapsuleOperationFailure,
  type CapsuleOperationIdempotencyKey,
  type CapsuleOperationStatusValue,
  type CapsuleOperationSummary,
  type CapsuleUnarchiveOperationOutput,
} from '@qiln/core/server'

const CLIENT_SAFE_FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_:-]{0,127}$/
const DEFAULT_CLIENT_FAILURE_CODE = 'CAPSULE_OPERATION_FAILED'
const DEFAULT_CLIENT_CLEANUP_CODE = 'CAPSULE_OPERATION_CLEANUP_REQUIRED'

type CapsuleOperationSummaryRow = Pick<
  typeof capsuleOperationsTable.$inferSelect,
  | 'id'
  | 'capsuleId'
  | 'branchId'
  | 'actorType'
  | 'actorId'
  | 'type'
  | 'status'
  | 'acceptedAt'
  | 'executionStartedAt'
  | 'providerMutationStartedAt'
  | 'completedAt'
  | 'failedAt'
  | 'failureCode'
  | 'failureMessage'
>

export interface CapsuleMutationIdentity {
  readonly ownerId: string
  readonly actor: CapsuleActorReference
}

export interface CapsuleCreateRequest {
  rootBranchName: CapsuleBranchName
  idempotencyKey: CapsuleOperationIdempotencyKey
  blueprintName?: string
  blueprintDigest: CapsuleBlueprintDigest
  cpu?: string
  memory?: string
}

/**
 * Public Engine boundary for durable capsule operations.
 *
 * Mutation methods accept authority derived from authenticated Engine context.
 * Browser input never supplies owner or actor identity. Commands are submitted
 * through the Capsule Channel with both the authorized owner target and
 * immutable actor provenance.
 *
 * Mutation responses are durable acceptance receipts and do not claim that an
 * asynchronous provider mutation has completed.
 *
 * Read methods query PostgreSQL directly because durable operation state is
 * authoritative. Client summaries are projected locally from a narrow SQL
 * selection that deliberately excludes request hashes, idempotency keys,
 * blueprint snapshots, raw failure details, and provider diagnostics.
 */
export class CapsuleOperationsService {
  constructor(
    private readonly db: CapsuleHostDbContract,
    private readonly channel: CapsuleChannel,
  ) {}

  public async create(identity: CapsuleMutationIdentity, input: CapsuleCreateRequest): Promise<CapsuleCreateOutput> {
    const output = await this.channel.command(CapsuleCreateCommandName.CAPSULE_CREATE, {
      target: { type: TargetType.OWNER, id: identity.ownerId },
      actor: identity.actor,
      rootBranchName: CapsuleBranchNameSchema.parse(input.rootBranchName),
      idempotencyKey: input.idempotencyKey,
      blueprintName: input.blueprintName ?? DEFAULT_CAPSULE_BLUEPRINT_NAME,
      blueprintDigest: input.blueprintDigest,
      cpu: input.cpu ?? '4',
      memory: input.memory ?? '4GB',
    })
    return CapsuleCreateOutputSchema.parse(output)
  }

  public async archive(
    identity: CapsuleMutationIdentity,
    capsuleId: string,
    idempotencyKey: CapsuleOperationIdempotencyKey,
  ): Promise<CapsuleArchiveOperationOutput> {
    const output = await this.channel.command(CapsuleOperationCommandName.CAPSULE_ARCHIVE, {
      target: {
        type: TargetType.OWNER,
        id: identity.ownerId,
      },
      actor: identity.actor,
      capsuleId,
      idempotencyKey,
    })
    return CapsuleArchiveOperationOutputSchema.parse(output)
  }

  public async unarchive(
    identity: CapsuleMutationIdentity,
    capsuleId: string,
    idempotencyKey: CapsuleOperationIdempotencyKey,
  ): Promise<CapsuleUnarchiveOperationOutput> {
    const output = await this.channel.command(CapsuleOperationCommandName.CAPSULE_UNARCHIVE, {
      target: {
        type: TargetType.OWNER,
        id: identity.ownerId,
      },
      actor: identity.actor,
      capsuleId,
      idempotencyKey,
    })
    return CapsuleUnarchiveOperationOutputSchema.parse(output)
  }

  public async destroy(
    identity: CapsuleMutationIdentity,
    capsuleId: string,
    idempotencyKey: CapsuleOperationIdempotencyKey,
  ): Promise<CapsuleDestroyOperationOutput> {
    const output = await this.channel.command(CapsuleOperationCommandName.CAPSULE_DESTROY, {
      target: {
        type: TargetType.OWNER,
        id: identity.ownerId,
      },
      actor: identity.actor,
      capsuleId,
      idempotencyKey,
    })
    return CapsuleDestroyOperationOutputSchema.parse(output)
  }

  /**
   * Resolves one operation through its complete authenticated owner identity.
   *
   * The owner predicate is part of the SQL query so a foreign operation is
   * indistinguishable from a missing operation.
   */
  public async get(ownerId: string, operationId: string): Promise<CapsuleOperationSummary | null> {
    const [operation] = await this.db
      .select({
        id: capsuleOperationsTable.id,
        capsuleId: capsuleOperationsTable.capsuleId,
        branchId: capsuleOperationsTable.branchId,
        actorType: capsuleOperationsTable.actorType,
        actorId: capsuleOperationsTable.actorId,
        type: capsuleOperationsTable.type,
        status: capsuleOperationsTable.status,
        acceptedAt: capsuleOperationsTable.acceptedAt,
        executionStartedAt: capsuleOperationsTable.executionStartedAt,
        providerMutationStartedAt: capsuleOperationsTable.providerMutationStartedAt,
        completedAt: capsuleOperationsTable.completedAt,
        failedAt: capsuleOperationsTable.failedAt,
        failureCode: capsuleOperationsTable.failureCode,
        failureMessage: capsuleOperationsTable.failureMessage,
      })
      .from(capsuleOperationsTable)
      .where(and(eq(capsuleOperationsTable.id, operationId), eq(capsuleOperationsTable.ownerId, ownerId)))
      .limit(1)
    return operation ? this.toClientSafeSummary(operation) : null
  }

  /**
   * Lists authoritative operation history for one owner-scoped capsule.
   *
   * Missing and foreign capsule identities both produce an empty result. This
   * avoids disclosing whether another owner's capsule exists.
   */
  public async list(ownerId: string, capsuleId: string): Promise<CapsuleOperationSummary[]> {
    const operations = await this.db
      .select({
        id: capsuleOperationsTable.id,
        capsuleId: capsuleOperationsTable.capsuleId,
        branchId: capsuleOperationsTable.branchId,
        actorType: capsuleOperationsTable.actorType,
        actorId: capsuleOperationsTable.actorId,
        type: capsuleOperationsTable.type,
        status: capsuleOperationsTable.status,
        acceptedAt: capsuleOperationsTable.acceptedAt,
        executionStartedAt: capsuleOperationsTable.executionStartedAt,
        providerMutationStartedAt: capsuleOperationsTable.providerMutationStartedAt,
        completedAt: capsuleOperationsTable.completedAt,
        failedAt: capsuleOperationsTable.failedAt,
        failureCode: capsuleOperationsTable.failureCode,
        failureMessage: capsuleOperationsTable.failureMessage,
      })
      .from(capsuleOperationsTable)
      .where(and(eq(capsuleOperationsTable.ownerId, ownerId), eq(capsuleOperationsTable.capsuleId, capsuleId)))
      .orderBy(asc(capsuleOperationsTable.acceptedAt), asc(capsuleOperationsTable.id))
    return operations.map(operation => this.toClientSafeSummary(operation))
  }

  private toClientSafeSummary(operation: CapsuleOperationSummaryRow): CapsuleOperationSummary {
    const summary = {
      id: operation.id,
      capsuleId: operation.capsuleId,
      branchId: operation.branchId,
      actor: {
        type: operation.actorType,
        id: operation.actorId,
      },
      type: operation.type,
      status: operation.status,
      acceptedAt: this.toIsoTimestamp(operation.acceptedAt, 'acceptedAt', operation.id),
      executionStartedAt: this.toNullableIsoTimestamp(operation.executionStartedAt, 'executionStartedAt', operation.id),
      providerMutationStartedAt: this.toNullableIsoTimestamp(operation.providerMutationStartedAt, 'providerMutationStartedAt', operation.id),
      completedAt: this.toNullableIsoTimestamp(operation.completedAt, 'completedAt', operation.id),
      failedAt: this.toNullableIsoTimestamp(operation.failedAt, 'failedAt', operation.id),
      failure: this.toClientSafeFailure(operation),
    }
    const parsed = CapsuleOperationSummarySchema.safeParse(summary)
    if (!parsed.success) {
      throw new GlobalError('Durable capsule operation state failed client-safe summary validation.', GlobalErrorCode.INTERNAL_ERROR, {
        operationId: operation.id,
        validation: parsed.error.issues.map(issue => ({
          code: issue.code,
          path: issue.path.map(segment => String(segment)),
          message: issue.message,
        })),
      })
    }
    return parsed.data
  }

  private toClientSafeFailure(operation: CapsuleOperationSummaryRow): CapsuleOperationFailure | null {
    const hasFailureData = operation.failedAt !== null || operation.failureCode !== null || operation.failureMessage !== null
    if (!hasFailureData) {
      return null
    }
    if (operation.failedAt === null || operation.failureCode === null || operation.failureMessage === null) {
      throw new GlobalError('Durable capsule operation contains incomplete failure state.', GlobalErrorCode.INTERNAL_ERROR, {
        operationId: operation.id,
        operationStatus: operation.status,
        hasFailedAt: operation.failedAt !== null,
        hasFailureCode: operation.failureCode !== null,
        hasFailureMessage: operation.failureMessage !== null,
      })
    }
    const failure = {
      code: this.clientSafeFailureCode(operation.status, operation.failureCode),
      message: this.clientSafeFailureMessage(operation.status),
      occurredAt: this.toIsoTimestamp(operation.failedAt, 'failedAt', operation.id),
    }
    const parsed = CapsuleOperationFailureSchema.safeParse(failure)
    if (!parsed.success) {
      throw new GlobalError('Durable capsule operation failure failed client-safe validation.', GlobalErrorCode.INTERNAL_ERROR, {
        operationId: operation.id,
        validation: parsed.error.issues.map(issue => ({
          code: issue.code,
          path: issue.path.map(segment => String(segment)),
          message: issue.message,
        })),
      })
    }
    return parsed.data
  }

  private clientSafeFailureCode(status: CapsuleOperationStatusValue, persistedCode: string): string {
    const normalizedCode = persistedCode.trim()
    if (CLIENT_SAFE_FAILURE_CODE_PATTERN.test(normalizedCode)) {
      return normalizedCode
    }
    return status === CapsuleOperationStatus.CLEANUP_REQUIRED ? DEFAULT_CLIENT_CLEANUP_CODE : DEFAULT_CLIENT_FAILURE_CODE
  }

  private clientSafeFailureMessage(status: CapsuleOperationStatusValue): string {
    if (status === CapsuleOperationStatus.CLEANUP_REQUIRED) {
      return 'This capsule operation requires manual cleanup and inspection.'
    }
    return 'The capsule operation failed.'
  }

  private toIsoTimestamp(value: Date, field: string, operationId: string): string {
    if (!(value instanceof Date)) {
      throw new GlobalError('Durable capsule operation contains a non-Date timestamp.', GlobalErrorCode.INTERNAL_ERROR, {
        operationId,
        field,
        valueType: typeof value,
      })
    }
    const timestamp = value.getTime()
    if (!Number.isFinite(timestamp)) {
      throw new GlobalError('Durable capsule operation contains an invalid timestamp.', GlobalErrorCode.INTERNAL_ERROR, {
        operationId,
        field,
      })
    }
    return value.toISOString()
  }

  private toNullableIsoTimestamp(value: Date | null, field: string, operationId: string): string | null {
    return value === null ? null : this.toIsoTimestamp(value, field, operationId)
  }
}
