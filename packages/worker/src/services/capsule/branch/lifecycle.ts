import {
  DEFAULT_CAPSULE_BLUEPRINT_NAME,
  type CapsuleBlueprintDigest,
  type CapsuleBlueprintRegistry,
  type CapsuleBranchDeleteOutput,
  type CapsuleBranchStatus,
  type CapsuleChannel,
  type CapsuleCommandAck,
  type CapsuleHostDbContract,
} from '@qiln/core/server'
import { extractIpv4 } from '../../../incus/utils'
import { IncusError } from '../../../errors'
import { CapsuleBranchEventPublisher } from './events'
import { CapsuleResourceDriver } from '../resources/driver'
import { CapsuleBranchCreatePlanner } from '../operations/branch/create/planner'
import { CapsuleBranchProvisioningOperation } from '../operations/branch/create/provisioning'
import { CapsuleBranchDeletePlanner } from '../operations/branch/delete/planner'
import { CapsuleBranchDeprovisioningOperation } from '../operations/branch/delete/deprovisioning'
import { CapsuleAbandonedOperationError, CapsuleCompensationStatus, createOperationFailureContext } from '../operations/errors'
import { CapsuleBranchOperationStepStore, CapsuleBranchOperationStore, CapsuleBranchResourceStore, CapsuleBranchStore } from '../stores'
import type { IncusClient } from '../../../incus/client/index'
import type { ProjectService } from '../../project'
import type { AbandonedBranchCreateOperationCandidate, AbandonedBranchDeleteOperationCandidate, ReconcileBranch } from '../stores/types'

/**
 * Public worker service for capsule branch runtime mutations.
 *
 * This façade keeps the command-handler surface stable while delegating durable
 * branch mutations to inline fail-closed operation sagas.
 */
export class CapsuleBranchRuntimeService {
  private readonly branches: CapsuleBranchStore
  private readonly operations: CapsuleBranchOperationStore
  private readonly steps: CapsuleBranchOperationStepStore
  private readonly resources: CapsuleBranchResourceStore
  private readonly events: CapsuleBranchEventPublisher
  private readonly provisioning: CapsuleBranchProvisioningOperation
  private readonly deprovisioning: CapsuleBranchDeprovisioningOperation

  constructor(
    private readonly db: CapsuleHostDbContract,
    private readonly incus: IncusClient,
    private readonly channel: CapsuleChannel,
    private readonly project: ProjectService,
    private readonly blueprints: CapsuleBlueprintRegistry,
  ) {
    this.branches = new CapsuleBranchStore(this.db)
    this.operations = new CapsuleBranchOperationStore(this.db)
    this.steps = new CapsuleBranchOperationStepStore(this.db)
    this.resources = new CapsuleBranchResourceStore(this.db)
    this.events = new CapsuleBranchEventPublisher(this.channel)
    const planner = new CapsuleBranchCreatePlanner()
    const driver = new CapsuleResourceDriver(this.incus, this.project)
    const stores = {
      branches: this.branches,
      operations: this.operations,
      steps: this.steps,
      resources: this.resources,
    }
    this.provisioning = new CapsuleBranchProvisioningOperation(stores, planner, driver, this.events, this.blueprints, ownerId =>
      this.project.getNamespace(ownerId),
    )
    this.deprovisioning = new CapsuleBranchDeprovisioningOperation(stores, new CapsuleBranchDeletePlanner(), this.incus, this.events, ownerId =>
      this.project.getNamespace(ownerId),
    )
  }

  /**
   * Fetches the list of capsule branches for a specific owner.
   */
  public async list(ownerId: string) {
    return await this.branches.listBranches(ownerId)
  }

  /**
   * Fetches the database state of a capsule branch and opportunistically
   * enriches it with the live Incus IPv4 address when the branch is active.
   */
  public async state(ownerId: string, name: string) {
    const branch = await this.branches.findBranch(ownerId, name)
    if (!branch) {
      return null
    }
    let ip = branch.runtimeIp
    if (branch.status === 'online' || branch.status === 'starting') {
      try {
        const namespace = this.project.getNamespace(ownerId)
        const project = this.incus.UseProject(namespace)
        const { data: runtime } = await project.instances.state(name)
        ip = extractIpv4(runtime.network) || ip
      } catch {
        console.warn(`[CapsuleBranchRuntimeService] Could not fetch live Incus state for branch '${name}'. Degrading gracefully.`)
      }
    }
    return { ...branch, runtimeIp: ip }
  }

  /**
   * Provisions a new capsule branch using a durable operation identity.
   *
   * The operation runs inline. Durable rows are used for idempotency, failure inspection,
   * and fail-closed cleanup accounting; abandoned provisioning is not automatically resumed.
   */
  public async create(
    ownerId: string,
    name: string,
    blueprintName: string = DEFAULT_CAPSULE_BLUEPRINT_NAME,
    blueprintDigest: CapsuleBlueprintDigest,
    idempotencyKey: string,
    cpu: string = '4',
    memory: string = '4GB',
  ) {
    return await this.provisioning.execute({
      ownerId,
      name,
      blueprintName,
      blueprintDigest,
      idempotencyKey,
      cpu,
      memory,
    })
  }

  /**
   * Marks branch operations left non-terminal by a previous worker process as cleanup_required.
   *
   * This is fail-closed accounting, not automatic recovery. The worker does not resume steps or
   * attempt to infer whether side effects completed safely.
   */
  public async markAbandonedBranchOperationsCleanupRequired(): Promise<void> {
    await this.markAbandonedBranchCreateOperationsCleanupRequired()
    await this.markAbandonedBranchDeleteOperationsCleanupRequired()
  }

  /**
   * Starts an existing offline capsule branch.
   */
  public async start(ownerId: string, name: string): Promise<CapsuleCommandAck> {
    const branch = await this.branches.findBranch(ownerId, name)
    if (!branch) {
      throw new IncusError('Capsule branch not found or access denied.', 'NOT_FOUND')
    }
    const transitioned = await this.transitionBranchStateWhereStatusAndPublish(ownerId, name, 'starting', ['offline'])
    if (!transitioned) {
      throw new IncusError('Capsule branch can only be started from the offline state.', 'CONFLICT')
    }
    const namespace = this.project.getNamespace(ownerId)
    const project = this.incus.UseProject(namespace)
    try {
      await project.instances.start(name)
      let ip: string | null = null
      try {
        const { data: state } = await project.instances.state(name)
        ip = extractIpv4(state.network)
      } catch {
        console.warn(
          `[CapsuleBranchRuntimeService] Failed to extract IP for branch '${name}' immediately after start. Will rely on heartbeat/backfill.`,
        )
      }
      await this.transitionBranchStateAndPublish(ownerId, name, 'online', ip)
      return { ok: true }
    } catch (error: unknown) {
      await this.transitionBranchStateAndPublish(ownerId, name, 'offline')
      throw error
    }
  }

  /**
   * Stops an active capsule branch.
   */
  public async stop(ownerId: string, name: string): Promise<CapsuleCommandAck> {
    const branch = await this.branches.findBranch(ownerId, name)
    if (!branch) {
      throw new IncusError('Capsule branch not found or access denied.', 'NOT_FOUND')
    }
    const previousStatus = branch.status
    const transitioned = await this.transitionBranchStateWhereStatusAndPublish(ownerId, name, 'stopping', ['online', 'starting'])
    if (!transitioned) {
      throw new IncusError('Capsule branch can only be stopped while online or starting.', 'CONFLICT')
    }
    const namespace = this.project.getNamespace(ownerId)
    const project = this.incus.UseProject(namespace)
    try {
      await project.instances.stop(name)
      await this.transitionBranchStateAndPublish(ownerId, name, 'offline', null)
      return { ok: true }
    } catch (error: unknown) {
      await this.transitionBranchStateAndPublish(ownerId, name, previousStatus)
      throw error
    }
  }

  /**
   * Permanently deletes a capsule branch using a durable fail-closed operation ledger.
   */
  public async delete(ownerId: string, name: string, idempotencyKey: string): Promise<CapsuleBranchDeleteOutput> {
    return await this.deprovisioning.execute({
      ownerId,
      name,
      idempotencyKey,
    })
  }

  /**
   * Boot-time runtime-state reconciliation for existing, non-provisioning branches.
   *
   * This intentionally does not recover or resume abandoned branch operations.
   */
  public async reconcile(): Promise<void> {
    const dbBranches = await this.branches.listBranchesForReconcile()
    const activeBranches = dbBranches.filter(
      branch =>
        branch.status !== 'provisioning' &&
        branch.status !== 'recovering' &&
        branch.status !== 'deleting' &&
        branch.status !== 'error' &&
        branch.status !== 'cleanup_required',
    )
    const ownerMap = new Map<string, { ownerId: string; branches: ReconcileBranch[] }>()
    for (const branch of activeBranches) {
      const namespace = this.project.getNamespace(branch.ownerId)
      const entry = ownerMap.get(namespace) ?? {
        ownerId: branch.ownerId,
        branches: [],
      }
      entry.branches.push({
        ownerId: branch.ownerId,
        name: branch.name,
        status: branch.status,
      })
      ownerMap.set(namespace, entry)
    }
    for (const [namespace, entry] of ownerMap.entries()) {
      const project = this.incus.UseProject(namespace)
      try {
        const { data: instances } = await project.instances.list()
        const dbBranchByName = new Map(entry.branches.map(branch => [branch.name, branch]))
        const trackedNames = new Set(entry.branches.map(branch => branch.name))
        const onlineNames = instances.filter(instance => instance.status === 'Running').map(instance => instance.name)
        const offlineNames = instances.filter(instance => instance.status === 'Stopped').map(instance => instance.name)
        for (const onlineName of onlineNames) {
          if (!trackedNames.has(onlineName)) {
            continue
          }
          const current = dbBranchByName.get(onlineName)
          if (current && current.status !== 'online') {
            await this.transitionBranchStateAndPublish(entry.ownerId, onlineName, 'online')
          }
        }
        for (const offlineName of offlineNames) {
          if (!trackedNames.has(offlineName)) {
            continue
          }
          const current = dbBranchByName.get(offlineName)
          if (current && current.status !== 'offline') {
            await this.transitionBranchStateAndPublish(entry.ownerId, offlineName, 'offline', null)
          }
        }
      } catch (err: unknown) {
        console.warn(`[CapsuleBranchRuntimeService] Failed to reconcile owner namespace '${namespace}':`, err)
      }
    }
  }

  private async markAbandonedBranchCreateOperationsCleanupRequired(): Promise<void> {
    const candidates = await this.operations.listAbandonedBranchCreateOperationCandidates()
    if (candidates.length === 0) {
      return
    }
    console.warn(
      `[CapsuleBranchRuntimeService] Found ${candidates.length} abandoned branch create operation(s). Marking cleanup_required; automatic provisioning recovery is disabled.`,
    )
    for (const candidate of candidates) {
      await this.markAbandonedBranchCreateOperationCleanupRequired(candidate)
    }
  }

  private async markAbandonedBranchDeleteOperationsCleanupRequired(): Promise<void> {
    const candidates = await this.operations.listAbandonedBranchDeleteOperationCandidates()
    if (candidates.length === 0) {
      return
    }
    console.warn(
      `[CapsuleBranchRuntimeService] Found ${candidates.length} abandoned branch delete operation(s). Marking cleanup_required; automatic delete recovery is disabled.`,
    )
    for (const candidate of candidates) {
      await this.markAbandonedBranchDeleteOperationCleanupRequired(candidate)
    }
  }

  private async markAbandonedBranchCreateOperationCleanupRequired(candidate: AbandonedBranchCreateOperationCandidate): Promise<void> {
    const branch = await this.branches.findBranch(candidate.ownerId, candidate.branchName)
    const error = new CapsuleAbandonedOperationError('Capsule branch create operation was abandoned before completion.', {
      operationId: candidate.id,
      ownerId: candidate.ownerId,
      branchId: candidate.branchId,
      branchName: candidate.branchName,
      previousOperationStatus: candidate.status,
      branchExists: branch !== null,
      previousBranchStatus: branch?.status ?? null,
      policy: 'inline_fail_closed_ledger',
    })
    const markedOperation = await this.operations.markNonTerminalBranchOperationCleanupRequired(
      candidate.id,
      error,
      createOperationFailureContext({
        operationId: candidate.id,
        branchName: candidate.branchName,
        phase: 'startup_fail_closed_sweep',
        action: 'mark_abandoned_branch_create_cleanup_required',
        compensationStatus: CapsuleCompensationStatus.NOT_ATTEMPTED,
      }),
    )
    if (!markedOperation) {
      return
    }
    if (!branch) {
      console.warn(
        `[CapsuleBranchRuntimeService] Abandoned branch create operation '${candidate.id}' has no branch row for '${candidate.branchName}'. Operation marked cleanup_required.`,
      )
      return
    }
    await this.branches.transitionBranchState(candidate.ownerId, candidate.branchName, 'cleanup_required')
    this.events.publishStateChanged(candidate.ownerId, candidate.branchName, 'cleanup_required')
  }

  private async markAbandonedBranchDeleteOperationCleanupRequired(candidate: AbandonedBranchDeleteOperationCandidate): Promise<void> {
    const branch = await this.branches.findBranch(candidate.ownerId, candidate.branchName)
    const error = new CapsuleAbandonedOperationError('Capsule branch delete operation was abandoned before completion.', {
      operationId: candidate.id,
      ownerId: candidate.ownerId,
      branchId: candidate.branchId,
      branchName: candidate.branchName,
      previousOperationStatus: candidate.status,
      branchExists: branch !== null,
      previousBranchStatus: branch?.status ?? null,
      policy: 'inline_fail_closed_ledger',
    })
    const markedOperation = await this.operations.markNonTerminalBranchOperationCleanupRequired(
      candidate.id,
      error,
      createOperationFailureContext({
        operationId: candidate.id,
        branchName: candidate.branchName,
        phase: 'startup_fail_closed_sweep',
        action: 'mark_abandoned_branch_delete_cleanup_required',
      }),
    )
    if (!markedOperation) {
      return
    }
    if (!branch) {
      console.warn(
        `[CapsuleBranchRuntimeService] Abandoned branch delete operation '${candidate.id}' has no branch row for '${candidate.branchName}'. Operation marked cleanup_required.`,
      )
      return
    }
    await this.branches.transitionBranchState(candidate.ownerId, candidate.branchName, 'cleanup_required')
    this.events.publishStateChanged(candidate.ownerId, candidate.branchName, 'cleanup_required')
  }

  private async transitionBranchStateAndPublish(ownerId: string, name: string, status: CapsuleBranchStatus, ip?: string | null): Promise<void> {
    await this.branches.transitionBranchState(ownerId, name, status, ip)
    this.events.publishStateChanged(ownerId, name, status)
  }

  private async transitionBranchStateWhereStatusAndPublish(
    ownerId: string,
    name: string,
    status: CapsuleBranchStatus,
    allowedStatuses: CapsuleBranchStatus[],
  ): Promise<boolean> {
    const transitioned = await this.branches.transitionBranchStateWhereStatus(ownerId, name, status, allowedStatuses)
    if (transitioned) {
      this.events.publishStateChanged(ownerId, name, status)
    }
    return transitioned
  }
}
