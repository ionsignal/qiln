import path from 'node:path'
import { createHash } from 'node:crypto'
import { parseDocument, isMap, isSeq, isScalar, YAMLMap, YAMLSeq } from 'yaml'
import { and, eq, inArray } from 'drizzle-orm'
import {
  CapsuleBranchCreateOutputSchema,
  CapsuleBranchEventName,
  CapsuleOperationCleanupPolicy,
  CapsuleOperationResourceStatus,
  CapsuleOperationResourceType,
  CapsuleOperationStatus,
  CapsuleOperationType,
  DEFAULT_CAPSULE_BLUEPRINT_NAME,
  TargetType,
  capsuleBranchesTable,
  capsuleOperationResourcesTable,
  capsuleOperationsTable,
  type CapsuleBlueprint,
  type CapsuleBlueprintDigest,
  type CapsuleBlueprintRegistry,
  type CapsuleBranchCreateOutput,
  type CapsuleBranchStatus,
  type CapsuleChannel,
  type CapsuleCommandAck,
  type CapsuleHostDbContract,
  type CapsuleOperationResourceStatus as CapsuleOperationResourceStatusValue,
  type CapsuleOperationStatus as CapsuleOperationStatusValue,
  type TargetOwner,
} from '@qiln/core/server'
import { extractIpv4 } from '../../incus/utils'
import { IncusError, isUniqueConstraintViolation, readIncusErrorDetailCode } from '../../errors'
import { interpolate } from '../../utils/template'
import type { Node, ParsedNode } from 'yaml'
import type { IncusClient } from '../../incus/client/index'
import type { IncusDeviceMap } from '../../schemas/incus'
import type { ProjectService } from '../project'

const SOURCE_PROJECT = 'default'

interface ManagedVolume {
  pool: string
  volumeName: string
  mountPath: string
}

interface ReconcileBranch {
  name: string
  status: CapsuleBranchStatus
}

interface AcceptCreateOperationInput {
  ownerId: string
  name: string
  idempotencyKey: string
  requestHash: string
  blueprintName: string
  blueprintDigest: CapsuleBlueprintDigest
  blueprintSnapshot: CapsuleBlueprint
  cpu: string
  memory: string
}

interface AcceptedCreateOperation {
  operationId: string
  branchId: string
  replayedReceipt?: CapsuleBranchCreateOutput
}

interface OperationResourceInput {
  operationId: string
  ownerId: string
  branchId: string
  branchName: string
  resourceType: CapsuleOperationResourceType
  resourceKey: string
  cleanupPolicy: CapsuleOperationCleanupPolicy
  status?: CapsuleOperationResourceStatusValue
  metadata?: Record<string, unknown>
}

type CanonicalJson = string | number | boolean | null | CanonicalJson[] | { [key: string]: CanonicalJson }
type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
type JsonObject = { [key: string]: JsonValue }

/**
 * Privileged worker service for capsule branch runtime mutations.
 *
 * Incus still calls these resources "instances", but the persistence boundary
 * now uses capsule branch terminology. This service owns the translation between
 * Qiln capsule branch semantics and privileged Incus/ZFS side effects.
 */
export class CapsuleBranchRuntimeService {
  constructor(
    private readonly db: CapsuleHostDbContract,
    private readonly incus: IncusClient,
    private readonly channel: CapsuleChannel,
    private readonly project: ProjectService,
    private readonly blueprints: CapsuleBlueprintRegistry,
  ) {}

  /**
   * Fetches the list of capsule branches for a specific owner.
   */
  public async list(ownerId: string) {
    return await this.db.query.capsuleBranches.findMany({
      where: { ownerId },
      orderBy: (capsuleBranches, { desc }) => [desc(capsuleBranches.createdAt)],
    })
  }

  /**
   * Fetches the database state of a capsule branch and opportunistically
   * enriches it with the live Incus IPv4 address when the branch is active.
   */
  public async state(ownerId: string, name: string) {
    const branch = await this.db.query.capsuleBranches.findFirst({
      where: { name, ownerId },
    })
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
   * This PR keeps the existing in-memory compensation stack, but records the
   * operation and external resource intent in Postgres so a later recovery PR can
   * continue/rollback based on durable state instead of guessing from names.
   */
  public async create(
    ownerId: string,
    name: string,
    blueprintName: string = DEFAULT_CAPSULE_BLUEPRINT_NAME,
    blueprintDigest: CapsuleBlueprintDigest,
    idempotencyKey: string,
    cpu: string = '4',
    memory: string = '4GB',
  ): Promise<CapsuleBranchCreateOutput> {
    const requestHash = this.createBranchCreateRequestHash({
      name,
      blueprintName,
      blueprintDigest,
      cpu,
      memory,
    })
    const existingReceipt = await this.findExistingCreateOperationReceipt(ownerId, idempotencyKey, requestHash)
    if (existingReceipt) {
      return existingReceipt
    }
    const pin = this.blueprints.pin(blueprintName, blueprintDigest)
    const accepted = await this.acceptCreateOperation({
      ownerId,
      name,
      idempotencyKey,
      requestHash,
      blueprintName: pin.name,
      blueprintDigest: pin.digest,
      blueprintSnapshot: pin.blueprint,
      cpu,
      memory,
    })
    if (accepted.replayedReceipt) {
      return accepted.replayedReceipt
    }
    const operationId = accepted.operationId
    const branchId = accepted.branchId
    const blueprint = pin.blueprint
    const namespace = this.project.getNamespace(ownerId)
    const project = this.incus.UseProject(namespace)
    const rollbackStack: Array<() => Promise<void>> = []
    const managedVolumes: ManagedVolume[] = []
    try {
      const projectResourceId = await this.createOperationResource({
        operationId,
        ownerId,
        branchId,
        branchName: name,
        resourceType: CapsuleOperationResourceType.INCUS_PROJECT,
        resourceKey: this.projectResourceKey(namespace),
        cleanupPolicy: CapsuleOperationCleanupPolicy.RETAIN,
        status: CapsuleOperationResourceStatus.CREATING,
        metadata: {
          namespace,
        },
      })
      try {
        await this.project.ensureNamespace(ownerId)
        await this.transitionResourceStatus(projectResourceId, CapsuleOperationResourceStatus.CREATED)
      } catch (error: unknown) {
        await this.markResourceError(projectResourceId, error)
        throw error
      }
      this.publishStateChanged(ownerId, name, 'provisioning')
      const dynamicDevices: IncusDeviceMap = {}
      for (const volume of blueprint.provisioning.volumes) {
        const volumeName = `${name}-${volume.name}`
        switch (volume.type) {
          case 'bind':
            dynamicDevices[volume.name] = {
              type: 'disk',
              source: volume.host_path,
              path: volume.mount_path,
              readonly: volume.readonly ? 'true' : 'false',
              shift: volume.shifted ? 'true' : 'false',
            }
            await this.createOperationResource({
              operationId,
              ownerId,
              branchId,
              branchName: name,
              resourceType: CapsuleOperationResourceType.BIND_MOUNT,
              resourceKey: this.bindMountResourceKey(namespace, volume.host_path, volume.mount_path),
              cleanupPolicy: CapsuleOperationCleanupPolicy.EXTERNAL,
              status: CapsuleOperationResourceStatus.CREATED,
              metadata: {
                namespace,
                hostPath: volume.host_path,
                mountPath: volume.mount_path,
                readonly: volume.readonly,
                shifted: volume.shifted,
              },
            })
            break
          case 'empty':
          case 'clone': {
            const resourceId = await this.createOperationResource({
              operationId,
              ownerId,
              branchId,
              branchName: name,
              resourceType: CapsuleOperationResourceType.ZFS_VOLUME,
              resourceKey: this.volumeResourceKey(namespace, volume.pool, volumeName),
              cleanupPolicy: CapsuleOperationCleanupPolicy.DELETE_ON_ROLLBACK,
              status: CapsuleOperationResourceStatus.CREATING,
              metadata: {
                namespace,
                pool: volume.pool,
                volumeName,
                mountPath: volume.mount_path,
                sourceVolume: volume.type === 'clone' ? volume.source_volume : null,
                volumeType: volume.type,
              },
            })
            const config: Record<string, string> = {}
            if (volume.shifted) {
              config['security.shifted'] = 'true'
            }
            try {
              if (volume.type === 'clone') {
                await project.storage.clone(volume.pool, volume.source_volume, volumeName, config, SOURCE_PROJECT)
              } else {
                await project.storage.create(volume.pool, volumeName, config)
              }
              await this.transitionResourceStatus(resourceId, CapsuleOperationResourceStatus.CREATED)
            } catch (error: unknown) {
              await this.markResourceError(resourceId, error)
              throw error
            }
            rollbackStack.push(async () => {
              await this.transitionResourceStatus(resourceId, CapsuleOperationResourceStatus.DELETING)
              try {
                await project.storage.delete(volume.pool, volumeName)
                await this.transitionResourceStatus(resourceId, CapsuleOperationResourceStatus.DELETED)
              } catch (rollbackErr: unknown) {
                if (rollbackErr instanceof IncusError && rollbackErr.code === 'NOT_FOUND') {
                  await this.transitionResourceStatus(resourceId, CapsuleOperationResourceStatus.MISSING)
                  return
                }
                await this.markResourceError(resourceId, rollbackErr)
                throw rollbackErr
              }
            })
            dynamicDevices[volume.name] = {
              type: 'disk',
              pool: volume.pool,
              source: volumeName,
              path: volume.mount_path,
              readonly: volume.readonly ? 'true' : 'false',
            }
            managedVolumes.push({
              pool: volume.pool,
              volumeName,
              mountPath: volume.mount_path,
            })
            break
          }
        }
      }
      managedVolumes.sort((a, b) => b.mountPath.length - a.mountPath.length)
      const env: Record<string, string> = {
        ...blueprint.instance_template.config,
        'environment.QILN_TENANT_ID': name,
        'limits.cpu': cpu,
        'limits.memory': memory,
      }
      if (managedVolumes.length > 0) {
        const chownCommands = managedVolumes.map(volume => ['chown', '1000:1000', volume.mountPath])
        env['user.vendor-data'] = this.mergeCloudInit(env['user.vendor-data'], chownCommands)
      }
      const devices: IncusDeviceMap = {
        ...blueprint.instance_template.devices,
        ...dynamicDevices,
      }
      const instanceResourceId = await this.createOperationResource({
        operationId,
        ownerId,
        branchId,
        branchName: name,
        resourceType: CapsuleOperationResourceType.INCUS_INSTANCE,
        resourceKey: this.instanceResourceKey(namespace, name),
        cleanupPolicy: CapsuleOperationCleanupPolicy.DELETE_ON_ROLLBACK,
        status: CapsuleOperationResourceStatus.CREATING,
        metadata: {
          namespace,
          instanceName: name,
          imageAlias: blueprint.image_alias,
        },
      })
      try {
        await project.instances.create({
          name,
          source: { type: 'image', alias: blueprint.image_alias },
          config: env,
          devices,
        })
        await this.transitionResourceStatus(instanceResourceId, CapsuleOperationResourceStatus.CREATED)
      } catch (error: unknown) {
        await this.markResourceError(instanceResourceId, error)
        throw error
      }
      rollbackStack.push(async () => {
        await this.transitionResourceStatus(instanceResourceId, CapsuleOperationResourceStatus.DELETING)
        try {
          await project.instances.delete(name)
          await this.transitionResourceStatus(instanceResourceId, CapsuleOperationResourceStatus.DELETED)
        } catch (rollbackErr: unknown) {
          if (rollbackErr instanceof IncusError && rollbackErr.code === 'NOT_FOUND') {
            await this.transitionResourceStatus(instanceResourceId, CapsuleOperationResourceStatus.MISSING)
            return
          }
          await this.markResourceError(instanceResourceId, rollbackErr)
          throw rollbackErr
        }
      })
      const interpolationContext = {
        name,
        env,
        limits: {
          cpu,
          memory: {
            raw: memory,
          },
        },
      }
      for (const file of blueprint.provisioning.files) {
        const content = file.content === undefined ? '' : interpolate(file.content, interpolationContext)
        const route = this.resolveFileTarget(file.path, managedVolumes)
        const pushOptions = {
          uid: file.uid,
          gid: file.gid,
          mode: file.mode,
          type: file.type,
        }
        if (route.target === 'volume') {
          await project.storage.files.write(route.pool, route.volumeName, route.internalPath, content, pushOptions)
        } else {
          await project.files.write(name, file.path, content, pushOptions)
        }
      }
      await this.transitionState(ownerId, name, 'offline')
      await this.transitionOperationStatus(operationId, CapsuleOperationStatus.COMPLETED)
      return this.createBranchCreateOutput(operationId, CapsuleOperationStatus.COMPLETED, name, 'offline', false)
    } catch (error: unknown) {
      console.error(`[CapsuleBranchRuntimeService] Provisioning failed for branch '${name}'. Initiating rollback...`, error)
      let rollbackHadFailure = false
      while (rollbackStack.length > 0) {
        const rollbackFn = rollbackStack.pop()
        if (!rollbackFn) {
          continue
        }
        try {
          await rollbackFn()
        } catch (rollbackErr: unknown) {
          rollbackHadFailure = true
          if (rollbackErr instanceof IncusError && rollbackErr.code === 'NOT_FOUND') {
            continue
          }
          console.error(`[CRITICAL] Zombie Resource Detected: Failed during rollback for branch '${name}':`, rollbackErr)
        }
      }
      if (rollbackHadFailure) {
        try {
          await this.transitionState(ownerId, name, 'cleanup_required')
        } catch (dbErr: unknown) {
          console.error(`[CRITICAL] Failed to mark branch '${name}' as cleanup_required:`, dbErr)
        }
        await this.markOperationFailure(operationId, CapsuleOperationStatus.CLEANUP_REQUIRED, error)
        throw error
      }
      try {
        await this.db.delete(capsuleBranchesTable).where(and(eq(capsuleBranchesTable.ownerId, ownerId), eq(capsuleBranchesTable.name, name)))
      } catch (dbErr: unknown) {
        console.error(`[CRITICAL] Ghost Record Detected: Failed to remove DB provisioning lock for branch '${name}':`, dbErr)
      }
      await this.markOperationFailure(operationId, CapsuleOperationStatus.FAILED, error)
      throw error
    }
  }

  /**
   * Starts an existing offline capsule branch.
   */
  public async start(ownerId: string, name: string): Promise<CapsuleCommandAck> {
    const branch = await this.db.query.capsuleBranches.findFirst({
      where: { name, ownerId },
    })
    if (!branch) {
      throw new IncusError('Capsule branch not found or access denied.', 'NOT_FOUND')
    }
    const transitioned = await this.transitionStateWhereStatus(ownerId, name, 'starting', ['offline'])
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
      await this.transitionState(ownerId, name, 'online', ip)
      return { ok: true }
    } catch (error: unknown) {
      await this.transitionState(ownerId, name, 'offline')
      throw error
    }
  }

  /**
   * Stops an active capsule branch.
   */
  public async stop(ownerId: string, name: string): Promise<CapsuleCommandAck> {
    const branch = await this.db.query.capsuleBranches.findFirst({
      where: { name, ownerId },
    })
    if (!branch) {
      throw new IncusError('Capsule branch not found or access denied.', 'NOT_FOUND')
    }
    const previousStatus = branch.status
    const transitioned = await this.transitionStateWhereStatus(ownerId, name, 'stopping', ['online', 'starting'])
    if (!transitioned) {
      throw new IncusError('Capsule branch can only be stopped while online or starting.', 'CONFLICT')
    }
    const namespace = this.project.getNamespace(ownerId)
    const project = this.incus.UseProject(namespace)
    try {
      await project.instances.stop(name)
      await this.transitionState(ownerId, name, 'offline', null)
      return { ok: true }
    } catch (error: unknown) {
      await this.transitionState(ownerId, name, previousStatus)
      throw error
    }
  }

  /**
   * Permanently deletes a capsule branch and all associated managed ZFS volumes.
   */
  public async delete(ownerId: string, name: string): Promise<CapsuleCommandAck> {
    const branch = await this.db.query.capsuleBranches.findFirst({
      where: { name, ownerId },
    })
    if (!branch) {
      throw new IncusError('Capsule branch not found or access denied.', 'NOT_FOUND')
    }
    if (branch.status === 'provisioning' || branch.status === 'recovering') {
      throw new IncusError('Cannot delete a capsule branch while it is provisioning or recovering.', 'CONFLICT')
    }
    const namespace = this.project.getNamespace(ownerId)
    const project = this.incus.UseProject(namespace)
    const volumesToDelete: { pool: string; source: string }[] = []
    await this.transitionState(ownerId, name, 'stopping')
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
      await this.transitionState(ownerId, name, 'error')
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
        await this.transitionState(ownerId, name, 'error')
        throw err
      }
    }
    try {
      await project.instances.delete(name)
    } catch (err: unknown) {
      if (!(err instanceof IncusError && err.code === 'NOT_FOUND')) {
        await this.transitionState(ownerId, name, 'error')
        throw err
      }
    }
    for (const volume of volumesToDelete) {
      try {
        await project.storage.delete(volume.pool, volume.source)
      } catch (err: unknown) {
        if (!(err instanceof IncusError && err.code === 'NOT_FOUND')) {
          await this.transitionState(ownerId, name, 'error')
          throw err
        }
      }
    }
    await this.db.delete(capsuleBranchesTable).where(and(eq(capsuleBranchesTable.ownerId, ownerId), eq(capsuleBranchesTable.name, name)))
    this.publishDeleted(ownerId, name)
    return { ok: true }
  }

  /**
   * Boot-time self-healing to align Postgres with true Incus state.
   */
  public async reconcile(): Promise<void> {
    const dbBranches = await this.db.query.capsuleBranches.findMany({
      columns: { name: true, ownerId: true, status: true },
    })
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
            await this.transitionState(entry.ownerId, onlineName, 'online')
          }
        }
        for (const offlineName of offlineNames) {
          if (!trackedNames.has(offlineName)) {
            continue
          }
          const current = dbBranchByName.get(offlineName)
          if (current && current.status !== 'offline') {
            await this.transitionState(entry.ownerId, offlineName, 'offline', null)
          }
        }
      } catch (err: unknown) {
        console.warn(`[CapsuleBranchRuntimeService] Failed to reconcile owner namespace '${namespace}':`, err)
      }
    }
  }

  private async findExistingCreateOperationReceipt(
    ownerId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<CapsuleBranchCreateOutput | null> {
    const operation = await this.db.query.capsuleOperations.findFirst({
      where: {
        ownerId,
        idempotencyKey,
        type: CapsuleOperationType.BRANCH_CREATE,
      },
      columns: {
        id: true,
        status: true,
        requestHash: true,
        branchName: true,
      },
    })
    if (!operation) {
      return null
    }
    if (operation.requestHash !== requestHash) {
      throw new IncusError('Idempotency key was already used with different capsule branch create input.', 'CONFLICT', {
        idempotencyKey,
      })
    }
    const branch = await this.db.query.capsuleBranches.findFirst({
      where: {
        ownerId,
        name: operation.branchName,
      },
      columns: {
        status: true,
      },
    })
    return this.createBranchCreateOutput(
      operation.id,
      operation.status,
      operation.branchName,
      branch?.status ?? this.fallbackBranchStatusForOperation(operation.status),
      true,
    )
  }

  private async acceptCreateOperation(input: AcceptCreateOperationInput): Promise<AcceptedCreateOperation> {
    try {
      const now = new Date()
      return await this.db.transaction(async tx => {
        const [operation] = await tx
          .insert(capsuleOperationsTable)
          .values({
            ownerId: input.ownerId,
            type: CapsuleOperationType.BRANCH_CREATE,
            status: CapsuleOperationStatus.ACCEPTED,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            branchName: input.name,
            blueprintName: input.blueprintName,
            blueprintDigest: input.blueprintDigest,
            blueprintSnapshot: input.blueprintSnapshot,
            createdAt: now,
            updatedAt: now,
          })
          .returning({
            id: capsuleOperationsTable.id,
          })
        if (!operation) {
          throw new IncusError('Failed to create durable capsule operation.', 'API_ERROR')
        }
        const [branch] = await tx
          .insert(capsuleBranchesTable)
          .values({
            ownerId: input.ownerId,
            name: input.name,
            blueprintName: input.blueprintName,
            blueprintDigest: input.blueprintDigest,
            cpu: input.cpu,
            memory: input.memory,
            status: 'provisioning',
            createdAt: now,
            updatedAt: now,
          })
          .returning({
            id: capsuleBranchesTable.id,
          })
        if (!branch) {
          throw new IncusError('Failed to create capsule branch provisioning record.', 'API_ERROR')
        }
        const [runningOperation] = await tx
          .update(capsuleOperationsTable)
          .set({
            branchId: branch.id,
            status: CapsuleOperationStatus.RUNNING,
            startedAt: now,
            updatedAt: now,
          })
          .where(eq(capsuleOperationsTable.id, operation.id))
          .returning({
            id: capsuleOperationsTable.id,
          })
        if (!runningOperation) {
          throw new IncusError('Failed to mark capsule operation as running.', 'API_ERROR')
        }
        return {
          operationId: runningOperation.id,
          branchId: branch.id,
        }
      })
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) {
        throw error
      }
      const replayedReceipt = await this.findExistingCreateOperationReceipt(input.ownerId, input.idempotencyKey, input.requestHash)
      if (replayedReceipt) {
        return {
          operationId: replayedReceipt.operationId,
          branchId: '',
          replayedReceipt,
        }
      }
      const existingBranch = await this.db.query.capsuleBranches.findFirst({
        where: {
          ownerId: input.ownerId,
          name: input.name,
        },
        columns: {
          id: true,
        },
      })
      if (existingBranch) {
        throw new IncusError(`Capsule branch '${input.name}' already exists.`, 'CONFLICT')
      }
      throw new IncusError('Capsule branch create operation conflicts with an existing durable operation.', 'CONFLICT')
    }
  }

  private async createOperationResource(input: OperationResourceInput): Promise<string> {
    const [resource] = await this.db
      .insert(capsuleOperationResourcesTable)
      .values({
        operationId: input.operationId,
        ownerId: input.ownerId,
        branchId: input.branchId,
        branchName: input.branchName,
        resourceType: input.resourceType,
        resourceKey: input.resourceKey,
        cleanupPolicy: input.cleanupPolicy,
        status: input.status ?? CapsuleOperationResourceStatus.PLANNED,
        metadata: input.metadata === undefined ? undefined : this.toJsonObject(input.metadata, 'capsule operation resource metadata'),
        updatedAt: new Date(),
      })
      .returning({
        id: capsuleOperationResourcesTable.id,
      })
    if (!resource) {
      throw new IncusError('Failed to record capsule operation resource.', 'API_ERROR')
    }
    return resource.id
  }

  private async transitionResourceStatus(
    resourceId: string,
    status: CapsuleOperationResourceStatusValue,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const updateData: {
      status: CapsuleOperationResourceStatusValue
      metadata?: Record<string, unknown>
      updatedAt: Date
    } = {
      status,
      updatedAt: new Date(),
    }
    if (metadata !== undefined) {
      updateData.metadata = this.toJsonObject(metadata, 'capsule operation resource metadata')
    }
    await this.db.update(capsuleOperationResourcesTable).set(updateData).where(eq(capsuleOperationResourcesTable.id, resourceId))
  }

  private async markResourceError(resourceId: string, error: unknown): Promise<void> {
    await this.transitionResourceStatus(resourceId, CapsuleOperationResourceStatus.ERROR, {
      error: this.detailsFromUnknown(error),
    })
  }

  private async transitionOperationStatus(operationId: string, status: CapsuleOperationStatusValue): Promise<void> {
    const now = new Date()
    const updateData: {
      status: CapsuleOperationStatusValue
      updatedAt: Date
      completedAt?: Date
      failedAt?: Date
    } = {
      status,
      updatedAt: now,
    }
    if (status === CapsuleOperationStatus.COMPLETED) {
      updateData.completedAt = now
    }
    if (status === CapsuleOperationStatus.FAILED || status === CapsuleOperationStatus.CLEANUP_REQUIRED) {
      updateData.failedAt = now
    }
    await this.db.update(capsuleOperationsTable).set(updateData).where(eq(capsuleOperationsTable.id, operationId))
  }

  private async markOperationFailure(operationId: string, status: CapsuleOperationStatusValue, error: unknown): Promise<void> {
    const details = this.detailsFromUnknown(error)
    const now = new Date()
    await this.db
      .update(capsuleOperationsTable)
      .set({
        status,
        failedAt: now,
        updatedAt: now,
        failureCode: error instanceof IncusError ? error.code : 'UNKNOWN',
        failureMessage: error instanceof Error ? error.message : 'Unknown capsule operation failure.',
        failureDetails: details === undefined ? undefined : this.toJsonObject(details, 'capsule operation failure details'),
      })
      .where(eq(capsuleOperationsTable.id, operationId))
  }

  private createBranchCreateOutput(
    operationId: string,
    operationStatus: CapsuleOperationStatusValue,
    branchName: string,
    branchStatus: CapsuleBranchStatus,
    replayed: boolean,
  ): CapsuleBranchCreateOutput {
    return CapsuleBranchCreateOutputSchema.parse({
      operationId,
      operationType: CapsuleOperationType.BRANCH_CREATE,
      operationStatus,
      branchName,
      branchStatus,
      replayed,
    })
  }

  private fallbackBranchStatusForOperation(status: CapsuleOperationStatusValue): CapsuleBranchStatus {
    switch (status) {
      case CapsuleOperationStatus.COMPLETED:
        return 'offline'
      case CapsuleOperationStatus.RECOVERING:
        return 'recovering'
      case CapsuleOperationStatus.CLEANUP_REQUIRED:
        return 'cleanup_required'
      case CapsuleOperationStatus.FAILED:
        return 'error'
      case CapsuleOperationStatus.ACCEPTED:
      case CapsuleOperationStatus.RUNNING:
      default:
        return 'provisioning'
    }
  }

  private createBranchCreateRequestHash(input: {
    name: string
    blueprintName: string
    blueprintDigest: CapsuleBlueprintDigest
    cpu: string
    memory: string
  }): string {
    const canonicalJson = JSON.stringify(this.toCanonicalJson(input))
    if (canonicalJson === undefined) {
      throw new IncusError('Failed to serialize capsule branch create input for idempotency hashing.', 'VALIDATION_ERROR')
    }
    return `sha256:${createHash('sha256').update(canonicalJson).digest('hex')}`
  }

  private toCanonicalJson(value: unknown, context = 'value'): CanonicalJson {
    if (value === null) {
      return null
    }

    if (typeof value === 'string' || typeof value === 'boolean') {
      return value
    }

    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new IncusError(`Cannot hash non-finite number at '${context}'.`, 'VALIDATION_ERROR', {
          context,
          value,
        })
      }
      return value
    }

    if (Array.isArray(value)) {
      return value.map((item, index) => this.toCanonicalJson(item, `${context}[${index}]`))
    }

    if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>
      const canonical: Record<string, CanonicalJson> = {}
      const keys = Object.keys(record).sort((left, right) => left.localeCompare(right))

      for (const key of keys) {
        const child = record[key]
        if (child === undefined) {
          continue
        }
        canonical[key] = this.toCanonicalJson(child, `${context}.${key}`)
      }

      return canonical
    }

    throw new IncusError(`Cannot hash non-JSON value at '${context}'.`, 'VALIDATION_ERROR', {
      context,
      valueType: typeof value,
    })
  }

  private toJsonObject(value: Record<string, unknown>, context: string): Record<string, unknown> {
    const normalized = this.toJsonValue(value, context)
    if (!this.isJsonObject(normalized)) {
      throw new IncusError(`${context} must normalize to a JSON object.`, 'VALIDATION_ERROR', {
        context,
      })
    }
    return normalized
  }

  private toJsonValue(value: unknown, context: string, seen: WeakSet<object> = new WeakSet()): JsonValue {
    if (value === null) {
      return null
    }
    if (typeof value === 'string' || typeof value === 'boolean') {
      return value
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new IncusError(`Cannot persist non-finite number in ${context}.`, 'VALIDATION_ERROR', {
          context,
          value,
        })
      }
      return value
    }

    if (value instanceof Date) {
      const timestamp = value.getTime()
      if (!Number.isFinite(timestamp)) {
        throw new IncusError(`Cannot persist invalid Date in ${context}.`, 'VALIDATION_ERROR', {
          context,
        })
      }
      return value.toISOString()
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) {
        throw new IncusError(`Cannot persist cyclic array in ${context}.`, 'VALIDATION_ERROR', {
          context,
        })
      }
      seen.add(value)
      try {
        return value.map((item, index) => (item === undefined ? null : this.toJsonValue(item, `${context}[${index}]`, seen)))
      } finally {
        seen.delete(value)
      }
    }
    if (typeof value === 'object') {
      if (seen.has(value)) {
        throw new IncusError(`Cannot persist cyclic object in ${context}.`, 'VALIDATION_ERROR', {
          context,
        })
      }
      if (!this.isPlainObject(value)) {
        throw new IncusError(`Cannot persist non-plain object in ${context}.`, 'VALIDATION_ERROR', {
          context,
          valueType: value.constructor?.name ?? 'Object',
        })
      }
      seen.add(value)
      try {
        const record = value as Record<string, unknown>
        const jsonObject: JsonObject = {}
        for (const [key, child] of Object.entries(record)) {
          if (child === undefined) {
            continue
          }

          jsonObject[key] = this.toJsonValue(child, `${context}.${key}`, seen)
        }
        return jsonObject
      } finally {
        seen.delete(value)
      }
    }
    throw new IncusError(`Cannot persist non-JSON value in ${context}.`, 'VALIDATION_ERROR', {
      context,
      valueType: typeof value,
    })
  }

  private isJsonObject(value: JsonValue): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  private isPlainObject(value: object): boolean {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  }

  private detailsFromUnknown(value: unknown): Record<string, unknown> | undefined {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
      }
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
    if (value === undefined || value === null) {
      return undefined
    }
    return {
      value,
    }
  }

  private projectResourceKey(namespace: string): string {
    return `incus:project:${namespace}`
  }

  private instanceResourceKey(namespace: string, instanceName: string): string {
    return `incus:instance:${namespace}:${instanceName}`
  }

  private volumeResourceKey(namespace: string, pool: string, volumeName: string): string {
    return `incus:storage-volume:${namespace}:${pool}:${volumeName}`
  }

  private bindMountResourceKey(namespace: string, hostPath: string, mountPath: string): string {
    return `incus:bind-mount:${namespace}:${hostPath}:${mountPath}`
  }

  private ownerTarget(ownerId: string): TargetOwner {
    return {
      type: TargetType.OWNER,
      id: ownerId,
    }
  }

  private async transitionState(ownerId: string, name: string, status: CapsuleBranchStatus, ip?: string | null): Promise<void> {
    const updateData: {
      status: CapsuleBranchStatus
      runtimeIp?: string | null
      updatedAt: Date
    } = {
      status,
      updatedAt: new Date(),
    }
    if (ip !== undefined) {
      updateData.runtimeIp = ip
    }
    await this.db
      .update(capsuleBranchesTable)
      .set(updateData)
      .where(and(eq(capsuleBranchesTable.ownerId, ownerId), eq(capsuleBranchesTable.name, name)))
    this.publishStateChanged(ownerId, name, status)
  }

  private async transitionStateWhereStatus(
    ownerId: string,
    name: string,
    status: CapsuleBranchStatus,
    allowedStatuses: CapsuleBranchStatus[],
  ): Promise<boolean> {
    if (allowedStatuses.length === 0) {
      return false
    }
    const result = await this.db
      .update(capsuleBranchesTable)
      .set({
        status,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(capsuleBranchesTable.ownerId, ownerId),
          eq(capsuleBranchesTable.name, name),
          inArray(capsuleBranchesTable.status, allowedStatuses),
        ),
      )
      .returning({ id: capsuleBranchesTable.id })
    if (result.length === 0) {
      return false
    }
    this.publishStateChanged(ownerId, name, status)
    return true
  }

  private publishStateChanged(ownerId: string, name: string, status: CapsuleBranchStatus): void {
    void this.channel
      .publish(CapsuleBranchEventName.BRANCH_STATE_CHANGED, {
        type: CapsuleBranchEventName.BRANCH_STATE_CHANGED,
        target: this.ownerTarget(ownerId),
        name,
        status,
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Unknown event publishing error'
        console.warn(`[CapsuleBranchRuntimeService] Failed to publish state '${status}' for branch '${name}':`, message)
      })
  }

  private publishDeleted(ownerId: string, name: string): void {
    void this.channel
      .publish(CapsuleBranchEventName.BRANCH_DELETED, {
        type: CapsuleBranchEventName.BRANCH_DELETED,
        target: this.ownerTarget(ownerId),
        name,
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Unknown event publishing error'
        console.warn(`[CapsuleBranchRuntimeService] Failed to publish deletion event for branch '${name}':`, message)
      })
  }

  /**
   * Evaluates a file path against a sorted list of managed volumes to determine
   * if the file should be routed to an offline ZFS volume instead of the rootfs.
   */
  private resolveFileTarget(
    filePath: string,
    managedVolumes: ManagedVolume[],
  ): { target: 'volume'; pool: string; volumeName: string; internalPath: string } | { target: 'instance' } {
    const normalizedFilePath = path.posix.normalize(filePath)
    for (const volume of managedVolumes) {
      const normalizedMountPath = path.posix.normalize(volume.mountPath)
      const relativePath = path.posix.relative(normalizedMountPath, normalizedFilePath)
      if (relativePath === '' || (!relativePath.startsWith('..') && !path.posix.isAbsolute(relativePath))) {
        return {
          target: 'volume',
          pool: volume.pool,
          volumeName: volume.volumeName,
          internalPath: path.posix.join('/', relativePath),
        }
      }
    }
    return { target: 'instance' }
  }

  /**
   * Safely merges new commands into the cloud-init bootcmd array using the YAML AST.
   * This preserves user comments, formatting, and surrounding structure.
   */
  private mergeCloudInit(existingData: string | undefined, commands: string[][]): string {
    if (existingData?.trimStart().startsWith('#!')) {
      throw new IncusError('Cannot merge cloud-init commands into a raw shell script.', 'VALIDATION_ERROR')
    }
    const cleanYaml = existingData ? existingData.replace(/^#cloud-config\s*\n/, '') : ''
    const doc = parseDocument(cleanYaml)
    if (!doc.contents || !isMap(doc.contents)) {
      doc.contents = doc.createNode({}) as unknown as ParsedNode
    }
    const rootMap = doc.contents as YAMLMap<unknown, unknown>
    if (isMap(rootMap)) {
      const rawBootcmd = rootMap.get('bootcmd', true)
      let seqNode: YAMLSeq<Node>
      if (!rawBootcmd) {
        seqNode = doc.createNode([]) as YAMLSeq<Node>
        rootMap.set('bootcmd', seqNode)
      } else if (isScalar(rawBootcmd)) {
        seqNode = doc.createNode([rawBootcmd.value]) as YAMLSeq<Node>
        rootMap.set('bootcmd', seqNode)
      } else if (isSeq(rawBootcmd)) {
        seqNode = rawBootcmd as YAMLSeq<Node>
      } else {
        seqNode = doc.createNode([]) as YAMLSeq<Node>
        rootMap.set('bootcmd', seqNode)
      }
      for (const command of commands) {
        seqNode.items.push(doc.createNode(command) as Node)
      }
    }
    return `#cloud-config\n${String(doc)}`
  }
}
