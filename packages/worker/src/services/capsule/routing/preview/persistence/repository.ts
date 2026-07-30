import type {
  CapsuleBranchPreviewListOutput,
  CapsulePersistence,
  CapsuleRouteApplicationPin,
  CapsuleRouteVerificationEvidence,
  CapsuleTables,
} from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { PreviewBranch, PreviewIdentity, PreviewPlan, PreviewRecord } from '../types'
import { PreviewFailurePersistence, type PreviewFailureTransition } from './failure'
import { PreviewIdentityPersistence } from './identity'
import { PreviewLifecyclePersistence } from './lifecycle'
import { PreviewLocks } from './locks'
import { PreviewReadPersistence } from './read'
import { PreviewRoutePersistence } from './route'
import { PreviewVerificationPersistence } from './verification'

/**
 * Composed preview persistence boundary.
 *
 * Each component owns its durable transitions and transaction policy. This
 * repository performs no SQL directly and is not a compatibility wrapper.
 */
export class PreviewRepository<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  private readonly read: PreviewReadPersistence<TDatabase, TTables>
  private readonly identity: PreviewIdentityPersistence<TDatabase, TTables>
  private readonly lifecycle: PreviewLifecyclePersistence<TDatabase, TTables>
  private readonly route: PreviewRoutePersistence<TDatabase, TTables>
  private readonly verification: PreviewVerificationPersistence<TDatabase, TTables>
  private readonly failure: PreviewFailurePersistence<TDatabase, TTables>

  constructor(persistence: CapsulePersistence<TDatabase, TTables>) {
    const locks = new PreviewLocks(persistence)
    this.read = new PreviewReadPersistence(persistence)
    this.identity = new PreviewIdentityPersistence(persistence, locks)
    this.lifecycle = new PreviewLifecyclePersistence(persistence, locks)
    this.route = new PreviewRoutePersistence(persistence, locks)
    this.verification = new PreviewVerificationPersistence(persistence, locks)
    this.failure = new PreviewFailurePersistence(persistence, locks)
  }

  public async branches(): Promise<PreviewBranch[]> {
    return await this.read.branches()
  }

  public async all(): Promise<PreviewRecord[]> {
    return await this.read.all()
  }

  public async list(ownerId: string, capsuleId: string): Promise<CapsuleBranchPreviewListOutput> {
    return await this.read.list(ownerId, capsuleId)
  }

  public async branch(branchId: string) {
    return await this.read.branch(branchId)
  }

  public async ensure(
    branch: PreviewBranch,
    application: CapsuleRouteApplicationPin,
    identity: PreviewIdentity,
  ): Promise<PreviewRecord> {
    return await this.identity.ensure(branch, application, identity)
  }

  public async withdraw(ownerId: string, capsuleId: string, branchId: string): Promise<PreviewRecord[]> {
    return await this.lifecycle.withdraw(ownerId, capsuleId, branchId)
  }

  public async resume(ownerId: string, capsuleId: string, branchId: string): Promise<void> {
    await this.lifecycle.resume(ownerId, capsuleId, branchId)
  }

  public async apply(id: string, plan: PreviewPlan): Promise<PreviewRecord> {
    return await this.route.apply(id, plan)
  }

  public async applied(id: string): Promise<PreviewRecord> {
    return await this.route.applied(id)
  }

  public async rejectApply(id: string, error: unknown, context: Record<string, unknown>): Promise<PreviewRecord> {
    return await this.route.rejectApply(id, error, context)
  }

  public async removing(id: string): Promise<PreviewRecord> {
    return await this.route.removing(id)
  }

  public async rejectRemoval(id: string, error: unknown, context: Record<string, unknown>): Promise<PreviewRecord> {
    return await this.route.rejectRemoval(id, error, context)
  }

  public async inactive(id: string): Promise<PreviewRecord> {
    return await this.route.inactive(id)
  }

  public async active(id: string, evidence: CapsuleRouteVerificationEvidence): Promise<PreviewRecord> {
    return await this.verification.active(id, evidence)
  }

  public async degraded(id: string, error: unknown, context: Record<string, unknown>): Promise<PreviewRecord> {
    return await this.verification.degraded(id, error, context)
  }

  public async cleanup(
    observed: PreviewRecord,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<PreviewFailureTransition> {
    return await this.failure.cleanup(observed, error, context)
  }
}
