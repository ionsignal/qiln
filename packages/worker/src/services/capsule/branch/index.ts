import {
  CapsuleBranchResourceStatus,
  DEFAULT_CAPSULE_BLUEPRINT_NAME,
  type CapsuleBlueprintDigest,
  type CapsuleBlueprintRegistry,
  type CapsuleBranchResourceStatus as CapsuleBranchResourceStatusValue,
  type CapsuleBranchStatus,
  type CapsuleChannel,
  type CapsuleCommandAck,
  type CapsuleHostDbContract,
} from '@qiln/core/server'
import { extractIpv4 } from '../../../incus/utils'
import { IncusError, readIncusErrorDetailCode } from '../../../errors'
import { CapsuleBranchEventPublisher } from './events'
import { CapsuleBranchCreatePlanner } from '../operations/branch/create/planner'
import { CapsuleResourceDriver } from '../resources/driver'
import { CapsuleBranchCreateSaga } from '../operations/branch/create/saga'
import { createBranchDeleteCleanupPlan } from '../operations/branch/delete/cleanupPlan'
import { CapsuleAbandonedOperationError, CapsuleCompensationStatus, createOperationFailureContext } from '../operations/errors'
import { detailsFromUnknown } from '../stores/errorDetails'
import { CapsuleBranchOperationStepStore, CapsuleBranchOperationStore, CapsuleBranchResourceStore, CapsuleBranchStore } from '../stores'
import type { IncusClient } from '../../../incus/client/index'
import type { ProjectService } from '../../project'
import type { BranchDeleteCleanupPlan, BranchDeleteVolumeTarget } from '../operations/branch/delete/types'
import type { AbandonedBranchCreateOperationCandidate, ReconcileBranch } from '../stores/types'

type ScopedIncusProject = ReturnType<IncusClient['UseProject']>

/**
 * Public worker service for capsule branch runtime mutations.
 *
 * This façade keeps the command-handler surface stable while delegating the create mutation to an inline
 * fail-closed operation ledger. Start, stop, delete, and runtime-state reconciliation remain direct
 * service methods until their own durable operation work is implemented.
 */
export class CapsuleBranchRuntimeService {
  private readonly branches: CapsuleBranchStore
  private readonly operations: CapsuleBranchOperationStore
  private readonly steps: CapsuleBranchOperationStepStore
  private readonly resources: CapsuleBranchResourceStore
  private readonly events: CapsuleBranchEventPublisher
  private readonly saga: CapsuleBranchCreateSaga

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
    this.saga = new CapsuleBranchCreateSaga(
      {
        branches: this.branches,
        operations: this.operations,
        steps: this.steps,
        resources: this.resources,
      },
      planner,
      driver,
      this.events,
      this.blueprints,
      ownerId => this.project.getNamespace(ownerId),
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
    return await this.saga.execute({
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
   * Marks branch-create operations left non-terminal by a previous worker process as cleanup_required.
   *
   * This is fail-closed accounting, not automatic recovery.
   * The worker does not resume steps or attempt to infer whether side effects completed safely.
   */
  public async markAbandonedBranchCreateOperationsCleanupRequired(): Promise<void> {
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
   * Permanently deletes a capsule branch and all associated managed ZFS volumes.
   */
  public async delete(ownerId: string, name: string): Promise<CapsuleCommandAck> {
    const branch = await this.branches.findBranch(ownerId, name)
    if (!branch) {
      throw new IncusError('Capsule branch not found or access denied.', 'NOT_FOUND')
    }
    if (branch.status === 'provisioning' || branch.status === 'recovering') {
      throw new IncusError('Cannot delete a capsule branch while it is provisioning or recovering.', 'CONFLICT')
    }
    const namespace = this.project.getNamespace(ownerId)
    const project = this.incus.UseProject(namespace)
    const inventory = await this.resources.listBranchResourceInventory(ownerId, name)
    let cleanupPlan: BranchDeleteCleanupPlan | null = null
    if (inventory.length > 0) {
      try {
        cleanupPlan = createBranchDeleteCleanupPlan(inventory)
      } catch (error: unknown) {
        await this.transitionBranchStateAndPublish(ownerId, name, 'cleanup_required')
        throw new IncusError('Capsule branch resource inventory is invalid. Marked for admin review.', 'CONFLICT', {
          branchName: name,
          error: detailsFromUnknown(error),
        })
      }
    }
    await this.transitionBranchStateAndPublish(ownerId, name, 'stopping')
    try {
      if (cleanupPlan) {
        await this.deleteUsingBranchResourceInventory(project, cleanupPlan, name)
      } else {
        console.warn(`[CapsuleBranchRuntimeService] Branch '${name}' has no durable resource inventory. Falling back to live Incus discovery.`)
        await this.deleteUsingLiveIncusDiscovery(project, name)
      }
    } catch (err: unknown) {
      await this.transitionBranchStateAndPublish(ownerId, name, 'error')
      throw err
    }
    await this.branches.deleteBranch(ownerId, name)
    this.events.publishDeleted(ownerId, name)
    return { ok: true }
  }

  /**
   * Boot-time runtime-state reconciliation for existing, non-provisioning branches.
   *
   * This intentionally does not recover or resume abandoned branch-create operations.
   */
  public async reconcile(): Promise<void> {
    const dbBranches = await this.branches.listBranchesForReconcile()
    const activeBranches = dbBranches.filter(
      branch =>
        branch.status !== 'provisioning' && branch.status !== 'recovering' && branch.status !== 'error' && branch.status !== 'cleanup_required',
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

  private async deleteUsingBranchResourceInventory(
    project: ScopedIncusProject,
    cleanupPlan: BranchDeleteCleanupPlan,
    branchName: string,
  ): Promise<void> {
    await this.deleteBranchInstance(project, cleanupPlan.instance?.resourceId ?? null, cleanupPlan.instance?.instanceName ?? branchName)
    for (const volume of cleanupPlan.volumes) {
      await this.deleteBranchVolume(project, volume)
    }
    for (const resourceId of cleanupPlan.provisioningFileResourceIds) {
      await this.transitionResourceStatusBestEffort(resourceId, CapsuleBranchResourceStatus.DELETED)
    }
  }

  private async deleteBranchInstance(project: ScopedIncusProject, resourceId: string | null, instanceName: string): Promise<void> {
    await this.transitionResourceStatusBestEffort(resourceId, CapsuleBranchResourceStatus.DELETING)
    let instanceMissing = false
    try {
      await project.instances.stop(instanceName)
    } catch (err: unknown) {
      const detailCode = err instanceof IncusError ? readIncusErrorDetailCode(err) : undefined
      if (err instanceof IncusError && err.code === 'NOT_FOUND') {
        instanceMissing = true
      } else if (!(err instanceof IncusError && detailCode === 400)) {
        await this.markResourceErrorBestEffort(resourceId, err, {
          action: 'stop_instance_before_delete',
          instanceName,
        })
        throw err
      }
    }
    if (instanceMissing) {
      await this.transitionResourceStatusBestEffort(resourceId, CapsuleBranchResourceStatus.MISSING)
      return
    }
    try {
      await project.instances.delete(instanceName)
      await this.transitionResourceStatusBestEffort(resourceId, CapsuleBranchResourceStatus.DELETED)
    } catch (err: unknown) {
      if (err instanceof IncusError && err.code === 'NOT_FOUND') {
        await this.transitionResourceStatusBestEffort(resourceId, CapsuleBranchResourceStatus.MISSING)
        return
      }
      await this.markResourceErrorBestEffort(resourceId, err, {
        action: 'delete_instance',
        instanceName,
      })
      throw err
    }
  }

  private async deleteBranchVolume(project: ScopedIncusProject, volume: BranchDeleteVolumeTarget): Promise<void> {
    await this.transitionResourceStatusBestEffort(volume.resourceId, CapsuleBranchResourceStatus.DELETING)
    try {
      await project.storage.delete(volume.pool, volume.volumeName)
      await this.transitionResourceStatusBestEffort(volume.resourceId, CapsuleBranchResourceStatus.DELETED)
    } catch (err: unknown) {
      if (err instanceof IncusError && err.code === 'NOT_FOUND') {
        await this.transitionResourceStatusBestEffort(volume.resourceId, CapsuleBranchResourceStatus.MISSING)
        return
      }
      await this.markResourceErrorBestEffort(volume.resourceId, err, {
        action: 'delete_volume',
        pool: volume.pool,
        volumeName: volume.volumeName,
      })
      throw err
    }
  }

  private async markResourceErrorBestEffort(resourceId: string | null, error: unknown, context?: Record<string, unknown>): Promise<void> {
    if (!resourceId) {
      return
    }
    try {
      await this.resources.markBranchResourceError(resourceId, error, context)
    } catch (dbError: unknown) {
      console.error(`[CapsuleBranchRuntimeService] Failed to persist resource error for '${resourceId}'.`, dbError)
    }
  }

  private async deleteUsingLiveIncusDiscovery(project: ScopedIncusProject, name: string): Promise<void> {
    const volumesToDelete: { pool: string; source: string }[] = []
    try {
      const { data } = await project.instances.get(name)
      if (data.devices) {
        for (const device of Object.values(data.devices)) {
          if (device.type === 'disk' && device.path !== '/' && typeof device.source === 'string' && typeof device.pool === 'string') {
            volumesToDelete.push({ pool: device.pool, source: device.source })
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof IncusError && err.code === 'NOT_FOUND') {
        throw new IncusError('Capsule branch container is missing on the host. Marked for admin review.', 'CONFLICT')
      }
      throw err
    }
    try {
      await project.instances.stop(name)
    } catch (err: unknown) {
      const detailCode = err instanceof IncusError ? readIncusErrorDetailCode(err) : undefined
      if (!(err instanceof IncusError && (err.code === 'NOT_FOUND' || detailCode === 400))) {
        throw err
      }
    }
    try {
      await project.instances.delete(name)
    } catch (err: unknown) {
      if (!(err instanceof IncusError && err.code === 'NOT_FOUND')) {
        throw err
      }
    }
    for (const volume of volumesToDelete) {
      try {
        await project.storage.delete(volume.pool, volume.source)
      } catch (err: unknown) {
        if (!(err instanceof IncusError && err.code === 'NOT_FOUND')) {
          throw err
        }
      }
    }
  }

  private async transitionResourceStatusBestEffort(resourceId: string | null, status: CapsuleBranchResourceStatusValue): Promise<void> {
    if (!resourceId) {
      return
    }
    try {
      await this.resources.transitionBranchResourceStatus(resourceId, status)
    } catch (error: unknown) {
      console.error(`[CapsuleBranchRuntimeService] Failed to mark resource '${resourceId}' as '${status}'.`, error)
    }
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
